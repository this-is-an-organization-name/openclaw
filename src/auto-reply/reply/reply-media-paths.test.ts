import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureSandboxWorkspaceForSession = vi.hoisted(() => vi.fn());
const saveMediaSource = vi.hoisted(() => vi.fn());

vi.mock("../../agents/sandbox.js", () => ({
  ensureSandboxWorkspaceForSession,
}));

vi.mock("../../media/store.js", () => ({
  saveMediaSource,
}));

import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";

describe("createReplyMediaPathNormalizer", () => {
  beforeEach(() => {
    ensureSandboxWorkspaceForSession.mockReset().mockResolvedValue(null);
    saveMediaSource.mockReset().mockResolvedValue({
      path: "/Users/peter/.openclaw/media/outbound/persisted.png",
    });
    vi.unstubAllEnvs();
  });

  it("resolves workspace-relative media against the agent workspace", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/photo.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: path.join("/tmp/agent-workspace", "out", "photo.png"),
      mediaUrls: [path.join("/tmp/agent-workspace", "out", "photo.png")],
    });
  });

  it("keeps workspace-based resolution even when sandbox exists", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/photo.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: path.join("/tmp/agent-workspace", "out", "photo.png"),
      mediaUrls: [path.join("/tmp/agent-workspace", "out", "photo.png")],
    });
  });

  it("passes through absolute host-local paths", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/Users/peter/Documents/report.pdf"],
    });

    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/Documents/report.pdf",
      mediaUrls: ["/Users/peter/Documents/report.pdf"],
    });
  });

  it("passes through host file URLs", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["file:///Users/peter/.openclaw/media/inbound/photo.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: "file:///Users/peter/.openclaw/media/inbound/photo.png",
      mediaUrls: ["file:///Users/peter/.openclaw/media/inbound/photo.png"],
    });
  });

  it("keeps managed generated media under shared state roots", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/Users/peter/.openclaw");
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/Users/peter/.openclaw/media/tool-image-generation/generated.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/tool-image-generation/generated.png",
      mediaUrls: ["/Users/peter/.openclaw/media/tool-image-generation/generated.png"],
    });
  });

  it("keeps managed outbound media under shared state roots", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/Users/peter/.openclaw");
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["/Users/peter/.openclaw/media/outbound/generated.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/outbound/generated.png",
      mediaUrls: ["/Users/peter/.openclaw/media/outbound/generated.png"],
    });
  });

  it("persists volatile workspace agent-state media into shared outbound media", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/Users/peter/.openclaw/workspace",
    });

    const source =
      "/Users/peter/.openclaw/workspace/.openclaw/media/tool-image-generation/generated.png";
    const result = await normalize({
      mediaUrls: [source],
    });

    expect(saveMediaSource).toHaveBeenCalledWith(source, undefined, "outbound");
    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/outbound/persisted.png",
      mediaUrls: ["/Users/peter/.openclaw/media/outbound/persisted.png"],
    });
  });

  it("deduplicates normalized media while preserving first-seen order", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["./out/photo.png", "/tmp/agent-workspace/out/photo.png", "https://a/b.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: "/tmp/agent-workspace/out/photo.png",
      mediaUrls: ["/tmp/agent-workspace/out/photo.png", "https://a/b.png"],
    });
  });

  it("drops unsafe media sources without mutating existing text", async () => {
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      text: "hello",
      mediaUrls: ["data:image/png;base64,AAAA"],
    });

    expect(result).toMatchObject({
      text: "hello",
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  });
});
