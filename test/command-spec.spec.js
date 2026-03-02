import { describe, expect, it } from "vitest";

import { COMMAND_SPECS, DO_AT_TYPE_BEHAVIORS, buildRegistrationCommands } from "../src/command-spec";

describe("command specification parity", () => {
  it("uses the same command names for runtime and registration", () => {
    const runtimeNames = Object.keys(COMMAND_SPECS).sort();
    const registeredNames = buildRegistrationCommands().map((cmd) => cmd.name).sort();

    expect(registeredNames).toEqual(runtimeNames);
  });

  it("keeps schedule/list/cancel commands permission-gated", () => {
    for (const name of ["pingroleat", "pingmeat", "sayat", "doat_list", "doat_cancel"]) {
      expect(COMMAND_SPECS[name].requiresModeratorOrOwner).toBe(true);
      expect(COMMAND_SPECS[name].requiresGuild).toBe(true);
      expect(COMMAND_SPECS[name].deferred).toBe(true);
    }
  });

  it("validates schedule command subjects as expected", () => {
    expect(COMMAND_SPECS.pingroleat.validateSubject("123456")).toBeNull();
    expect(COMMAND_SPECS.pingroleat.validateSubject("abc")).toBe("Invalid role.");

    expect(COMMAND_SPECS.pingmeat.validateSubject("987654321")).toBeNull();
    expect(COMMAND_SPECS.pingmeat.validateSubject("not-a-user")).toBe("Invalid user.");

    expect(COMMAND_SPECS.sayat.validateSubject("hi there")).toBeNull();
    expect(COMMAND_SPECS.sayat.validateSubject("")).toBe("Message cannot be empty.");
    expect(COMMAND_SPECS.sayat.validateSubject("x".repeat(2001))).toBe("Message too long (max 2000 chars).");
  });

  it("formats doAt message behavior with explicit allowed_mentions", () => {
    const roleJob = { doAtSubject: "111", scheduledUnix: 12345 };
    const roleBehavior = DO_AT_TYPE_BEHAVIORS["ping-role"];
    const roleInner = roleBehavior.innerContent(roleJob);
    expect(roleInner).toBe("<@&111>");
    expect(roleBehavior.allowedMentions(roleJob)).toEqual({ roles: ["111"] });
    expect(roleBehavior.outerContent(roleJob, roleInner)).toContain("scheduled role ping");

    const userJob = { doAtSubject: "222", scheduledUnix: 12345 };
    const userBehavior = DO_AT_TYPE_BEHAVIORS["ping-user"];
    const userInner = userBehavior.innerContent(userJob);
    expect(userInner).toBe("<@222>");
    expect(userBehavior.allowedMentions(userJob)).toEqual({ users: ["222"] });

    const messageJob = { doAtSubject: "plain text", scheduledUnix: 12345 };
    const messageBehavior = DO_AT_TYPE_BEHAVIORS["channel-message"];
    const messageInner = messageBehavior.innerContent(messageJob);
    expect(messageInner).toBe("plain text");
    expect(messageBehavior.allowedMentions(messageJob)).toEqual({ parse: [] });
    expect(messageBehavior.outerContent(messageJob, messageInner)).toBe("plain text");
  });
});
