import {
  defineFeature,
  defineScheduledAction,
  discordOption,
  discordScheduledActionCommand,
  frameworkApiVersion
} from "../../framework/index.js";
import {
  ANNOUNCEMENT_ACTION_KIND,
  TWITCH_ANNOUNCEMENT_TEXT_LIMITS
} from "../announcements/feature.js";

const INTERVAL_LIMITS = Object.freeze({ min: 600, max: 86_400 });

export const SCHEDULED_TWITCH_ANNOUNCEMENT_KIND =
  "discord.integration.announce-twitch-random.v1";

export const scheduledTwitchAnnouncementsFeature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "integrations.scheduled-twitch-announcements",
  description: "Schedules recurring announcements to linked Twitch chats.",
  schedules: [
    defineScheduledAction({
      kind: SCHEDULED_TWITCH_ANNOUNCEMENT_KIND,
      sourcePlatform: "discord",
      actionKind: ANNOUNCEMENT_ACTION_KIND,
      timing: "bounded-random",
      authorization: "grant-at-creation"
    })
  ],
  commands: {
    discord: [
      discordScheduledActionCommand({
        name: "integration_schedule_twitch",
        usage: "/integration_schedule_twitch message:Hello everyone! min_interval:600 max_interval:900",
        description: "Schedule a recurring message in linked Twitch chats.",
        availability: "guild",
        deferred: true,
        scheduleKind: SCHEDULED_TWITCH_ANNOUNCEMENT_KIND,
        options: [
          discordOption({
            arg: "message",
            name: "message",
            description: "Message to send.",
            type: "string",
            required: true,
            ...TWITCH_ANNOUNCEMENT_TEXT_LIMITS
          }),
          discordOption({
            arg: "min_interval",
            name: "min_interval",
            description: "Minimum interval in seconds.",
            type: "integer",
            required: false,
            ...INTERVAL_LIMITS
          }),
          discordOption({
            arg: "max_interval",
            name: "max_interval",
            description: "Maximum interval in seconds.",
            type: "integer",
            required: false,
            ...INTERVAL_LIMITS
          })
        ],
        mapSchedule(args) {
          return {
            actionArgs: { message: args.message },
            timing: {
              type: "bounded-random",
              minSeconds: args.min_interval ?? 7_200,
              maxSeconds: args.max_interval ?? 21_600
            },
            repeats: true
          };
        }
      })
    ]
  }
});

export default scheduledTwitchAnnouncementsFeature;
