// #12: the host start message (persisted AppSettings over the protocol) maps
// onto prompt languages, archive header labels, gauge config, and the router
// default — headless, per the issue's testability requirement.

import { describe, expect, it } from "vitest";

import { resolveStartConfig } from "../src/host/start-config";
import type { HostInbound } from "../src/protocol";

type StartMessage = Extract<HostInbound, { type: "start" }>;

function startMessage(overrides: Partial<StartMessage> = {}): StartMessage {
  return {
    type: "start",
    appDataDir: "/tmp/livecap-data",
    archiveDir: "/tmp/livecap-archives",
    targetLanguageCode: "ko",
    enginePref: "cli",
    poolUsd: 20,
    resetDay: 1,
    autoSwitch: true,
    archiveAutoSave: true,
    archiveRetentionDays: 0,
    ...overrides,
  };
}

describe("resolveStartConfig — language plumbing (#12 goal 4)", () => {
  it("routes the target language to the translation prompt, the summary, and the archive header", () => {
    const resolved = resolveStartConfig(startMessage({ targetLanguageCode: "ko" }));
    expect(resolved.targetLanguage).toBe("Korean"); // (a) translation system prompt
    expect(resolved.summaryLanguage).toBe("Korean"); // (b) extras/summary output
    expect(resolved.targetLangCode).toBe("KO"); // (c) archive header meta
    expect(resolved.sourceLangCode).toBe("EN");
  });

  it("supports EN as a target and arbitrary BCP-47 tags", () => {
    const en = resolveStartConfig(startMessage({ targetLanguageCode: "en" }));
    expect(en.targetLanguage).toBe("English");
    expect(en.targetLangCode).toBe("EN");

    const arbitrary = resolveStartConfig(startMessage({ targetLanguageCode: "nb-NO" }));
    expect(arbitrary.targetLanguage).toBe("nb-no");
    expect(arbitrary.targetLangCode).toBe("NB");
  });

  it("keeps reply/quick-translate output in the meeting language", () => {
    const resolved = resolveStartConfig(startMessage({ targetLanguageCode: "ja" }));
    expect(resolved.meetingLanguage).toBe("English");
    expect(resolved.summaryLanguage).toBe("Japanese");
  });
});

describe("resolveStartConfig — gauge + router mapping", () => {
  it("passes pool/reset-day through and clamps invalid values", () => {
    const ok = resolveStartConfig(startMessage({ poolUsd: 100, resetDay: 15 }));
    expect(ok.poolUsd).toBe(100);
    expect(ok.resetDay).toBe(15);

    const bad = resolveStartConfig(startMessage({ poolUsd: Number.NaN, resetDay: 99 }));
    expect(bad.poolUsd).toBe(20);
    expect(bad.resetDay).toBe(28);
  });

  it("maps engine preference and auto-switch", () => {
    expect(resolveStartConfig(startMessage({ enginePref: "local" })).enginePref).toBe("local");
    expect(resolveStartConfig(startMessage()).enginePref).toBe("cli");
    expect(resolveStartConfig(startMessage({ autoSwitch: false })).autoSwitch).toBe(false);
  });

  it("maps the archive group (auto-save, retention)", () => {
    const resolved = resolveStartConfig(startMessage({ archiveAutoSave: false, archiveRetentionDays: 90 }));
    expect(resolved.archiveAutoSave).toBe(false);
    expect(resolved.archiveRetentionDays).toBe(90);
    expect(resolveStartConfig(startMessage()).archiveRetentionDays).toBe(0); // forever
  });
});
