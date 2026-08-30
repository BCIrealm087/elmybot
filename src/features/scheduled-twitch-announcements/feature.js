import {
  defineFeature,
  defineScheduledAction,
  discordOption,
  discordScheduledActionCommand
} from "../../framework/index.js";
import { ANNOUNCEMENT_ACTION_KIND } from "../announcements/feature.js";

export const SCHEDULED_TWITCH_ANNOUNCEMENT_KIND =
  "discord.integration.announce-twitch-random.v1";

export const scheduledTwitchAnnouncementsFeature = defineFeature({
  apiVersion: 1,
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
            minLength: 1,
            maxLength: 500
          }),
          discordOption({
            arg: "min_interval",
            name: "min_interval",
            description: "Minimum interval in seconds.",
            type: "integer",
            required: false,
            min: 600,
            max: 86_400
          }),
          discordOption({
            arg: "max_interval",
            name: "max_interval",
            description: "Maximum interval in seconds.",
            type: "integer",
            required: false,
            min: 600,
            max: 86_400
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
