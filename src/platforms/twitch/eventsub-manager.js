import { logError } from "../../common.js";
import { registerTwitchChannel } from "./channel-registry.js";
import {
	ensureTwitchEventSubSubscriptions,
	removeTwitchEventSubSubscriptions
} from "./eventsub.js";
import {
	noStoreJson,
	RECOVERABLE_EVENTSUB_STATUS,
	TwitchEventSubError,
	validateChannelConfig
} from "./eventsub-common.js";

const RECOVERY_KEY = "pendingRecovery";
const CHANNEL_CONFIG_KEY = "channelConfig";
const RECOVERY_INITIAL_DELAY_MS = 1000;
const RECONCILIATION_INITIAL_DELAY_MS = 60 * 1000;
const RECONCILIATION_INTERVAL_MS = 55 * 60 * 1000;
const RECONCILIATION_JITTER_MS = 5 * 60 * 1000;
const RECOVERY_RETRY_DELAYS_MS = Object.freeze([
	60 * 1000,
	5 * 60 * 1000,
	15 * 60 * 1000,
	60 * 60 * 1000
]);

function validateRecovery(recovery) {
	const channel = validateChannelConfig(recovery);
	if (recovery.reason !== RECOVERABLE_EVENTSUB_STATUS) {
		throw new TwitchEventSubError("The EventSub recovery request is invalid.");
	}

	return {
		...channel,
		reason: recovery.reason,
		sourceSubscriptionId:
			typeof recovery.sourceSubscriptionId === "string"
				? recovery.sourceSubscriptionId
				: null,
		attempts: 0,
		queuedAtMs: Date.now()
	};
}

function nextReconciliationDelayMs() {
	return RECONCILIATION_INTERVAL_MS + Math.floor(
		Math.random() * (RECONCILIATION_JITTER_MS + 1)
	);
}

export class TwitchEventSubManagerBackend {
	constructor(state, env, registry) {
		this.state = state;
		this.env = env;
		this.subscriptionKinds = registry.kinds;
	}

	async configureChannel(channel) {
		const validated = validateChannelConfig(channel);
		const existing = await this.state.storage.get(CHANNEL_CONFIG_KEY);
		const configured = {
			...existing,
			...validated,
			enabled: true,
			configuredAtMs:
				existing?.enabled === false || !existing?.configuredAtMs
					? Date.now()
					: existing.configuredAtMs,
			lastResult: existing?.enabled === false
				? "pending"
				: existing?.lastResult ?? "pending",
			consecutiveFailures: existing?.enabled === false
				? 0
				: existing?.consecutiveFailures ?? 0
		};
		delete configured.deconfiguredAtMs;
		delete configured.removedSubscriptions;
		await this.state.storage.put(CHANNEL_CONFIG_KEY, configured);
		await this.state.storage.setAlarm(Date.now() + RECONCILIATION_INITIAL_DELAY_MS);
		return configured;
	}

	async deconfigureChannel(channel) {
		const validated = validateChannelConfig(channel);
		const existing = await this.state.storage.get(CHANNEL_CONFIG_KEY);
		const deconfigured = {
			...existing,
			...validated,
			authorizationMode:
				existing?.authorizationMode ?? validated.authorizationMode,
			enabled: false,
			configuredAtMs: existing?.configuredAtMs ?? null,
			deconfiguredAtMs: Date.now(),
			lastResult: "deconfiguration_pending",
			consecutiveFailures: 0
		};
		await this.state.storage.put(CHANNEL_CONFIG_KEY, deconfigured);
		await this.state.storage.delete(RECOVERY_KEY);
		await this.state.storage.setAlarm(Date.now() + RECOVERY_INITIAL_DELAY_MS);
		return deconfigured;
	}

	async queueRecovery(recovery) {
		const validated = validateRecovery(recovery);
		const [existingRecovery, existingConfig] = await Promise.all([
			this.state.storage.get(RECOVERY_KEY),
			this.state.storage.get(CHANNEL_CONFIG_KEY)
		]);
		if (existingConfig?.enabled === false) return false;
		await this.state.storage.put(CHANNEL_CONFIG_KEY, {
			...existingConfig,
			broadcasterUserId: validated.broadcasterUserId,
			callbackUrl: validated.callbackUrl,
			authorizationMode:
				existingConfig?.authorizationMode ?? validated.authorizationMode,
			enabled: true,
			configuredAtMs: existingConfig?.configuredAtMs ?? Date.now(),
			lastResult: existingConfig?.lastResult ?? "recovery_queued",
			consecutiveFailures: existingConfig?.consecutiveFailures ?? 0
		});
		if (
			existingRecovery?.sourceSubscriptionId &&
			existingRecovery.sourceSubscriptionId === validated.sourceSubscriptionId
		) {
			return true;
		}

		await this.state.storage.put(RECOVERY_KEY, validated);
		await this.state.storage.setAlarm(Date.now() + RECOVERY_INITIAL_DELAY_MS);
		return true;
	}

	async alarm() {
		const [recovery, channel] = await Promise.all([
			this.state.storage.get(RECOVERY_KEY),
			this.state.storage.get(CHANNEL_CONFIG_KEY)
		]);
		const target = channel ?? recovery;
		if (!target) return;

		try {
			if (channel?.enabled === false) {
				const result = await removeTwitchEventSubSubscriptions(
					channel,
					this.env,
					this.subscriptionKinds
				);
				const nowMs = Date.now();
				await this.state.storage.put(CHANNEL_CONFIG_KEY, {
					...channel,
					authorizationMode: channel.authorizationMode ?? "moderator",
					lastReconciledAtMs: nowMs,
					lastResult: "deconfigured",
					removedSubscriptions: result.removedSubscriptions,
					consecutiveFailures: 0
				});
				await this.state.storage.delete(RECOVERY_KEY);
				await this.state.storage.deleteAlarm();
				return;
			}

			const result = await ensureTwitchEventSubSubscriptions(
				target,
				this.env,
				this.subscriptionKinds
			);
			await registerTwitchChannel(this.env, target);
			const nowMs = Date.now();
			await this.state.storage.put(CHANNEL_CONFIG_KEY, {
				...target,
				authorizationMode: target.authorizationMode ?? "moderator",
				enabled: true,
				lastReconciledAtMs: nowMs,
				lastResult: result.result,
				lastSubscriptionId: result.subscriptionId,
				lastSubscriptionStatus: result.status,
				lastSubscriptions: result.subscriptions,
				consecutiveFailures: 0
			});
			if (recovery) {
				await this.state.storage.delete(RECOVERY_KEY);
				console.log(JSON.stringify({
					level: "info",
					event: "twitch.eventsub_recovered",
					platform: "twitch",
					groupId: target.broadcasterUserId,
					sourceSubscriptionId: recovery.sourceSubscriptionId,
					result: result.result
				}));
			}
			await this.state.storage.setAlarm(nowMs + nextReconciliationDelayMs());
		} catch (error) {
			const attempts = recovery
				? (recovery.attempts ?? 0) + 1
				: (channel?.consecutiveFailures ?? 0) + 1;
			const delayMs = RECOVERY_RETRY_DELAYS_MS[
				Math.min(attempts - 1, RECOVERY_RETRY_DELAYS_MS.length - 1)
			];
			if (recovery) {
				await this.state.storage.put(RECOVERY_KEY, {
					...recovery,
					attempts,
					lastAttemptAtMs: Date.now()
				});
			}
			if (channel) {
				await this.state.storage.put(CHANNEL_CONFIG_KEY, {
					...channel,
					lastReconciledAtMs: Date.now(),
					lastResult: "error",
					consecutiveFailures: attempts
				});
			}
			await this.state.storage.setAlarm(Date.now() + delayMs);
			logError("twitch.eventsub_reconciliation_failed", {
				platform: "twitch",
				correlationId: `twitch-eventsub-reconciliation:${crypto.randomUUID()}`,
				groupId: target.broadcasterUserId,
				sourceSubscriptionId: recovery?.sourceSubscriptionId ?? null,
				attempts,
				nextRetryInMs: delayMs
			}, error);
		}
	}

	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/recover") {
				const queued = await this.queueRecovery(await request.json());
				return noStoreJson({ queued }, 202);
			}
			if (request.method === "POST" && url.pathname === "/configure") {
				return noStoreJson({
					configured: true,
					channel: await this.configureChannel(await request.json())
				}, 202);
			}
			if (request.method === "POST" && url.pathname === "/deconfigure") {
				return noStoreJson({
					configured: false,
					channel: await this.deconfigureChannel(await request.json())
				}, 202);
			}
			if (request.method === "GET" && url.pathname === "/status") {
				const [channel, recovery, alarmAtMs] = await Promise.all([
					this.state.storage.get(CHANNEL_CONFIG_KEY),
					this.state.storage.get(RECOVERY_KEY),
					this.state.storage.getAlarm()
				]);
				return noStoreJson({
					configured: Boolean(channel && channel.enabled !== false),
					channel: channel
						? {
							...channel,
							authorizationMode: channel.authorizationMode ?? "moderator",
							enabled: channel.enabled !== false
						}
						: null,
					recovery: recovery
						? {
							reason: recovery.reason,
							attempts: recovery.attempts,
							queuedAtMs: recovery.queuedAtMs
						}
						: null,
					alarmAtMs
				});
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (error instanceof TwitchEventSubError) {
				return noStoreJson({ error: error.message, code: error.code }, error.status);
			}
			logError("twitch.eventsub_manager_failed", {
				platform: "twitch",
				correlationId: `twitch-eventsub-manager:${crypto.randomUUID()}`,
				groupId: null
			}, error);
			return noStoreJson({ error: "Twitch EventSub management failed." }, 500);
		}
	}
}
