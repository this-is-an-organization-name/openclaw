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
    saveMediaSource.mockReset();
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

  it("resolves relative media against the agent workspace even when sandbox exists", async () => {
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
      mediaUrls: ["./out/photo.png", "file:///workspace/screens/final.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: path.join("/tmp/agent-workspace", "out", "photo.png"),
      mediaUrls: [
        path.join("/tmp/agent-workspace", "out", "photo.png"),
        "file:///workspace/screens/final.png",
      ],
    });
  });

  it("allows arbitrary host-local media paths when workspaceOnly is false and sandbox exists", async () => {
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
      mediaUrls: ["/Users/peter/.openclaw/media/inbound/photo.png"],
    });

    // path restriction removed: agent tools already have unrestricted fs access
    // when workspaceOnly is false, so blocking MEDIA: was inconsistent
    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/inbound/photo.png",
      mediaUrls: ["/Users/peter/.openclaw/media/inbound/photo.png"],
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("resolves relative paths even when tools.fs.workspaceOnly is enabled", async () => {
    ensureSandboxWorkspaceForSession.mockResolvedValue({
      workspaceDir: "/tmp/sandboxes/session-1",
      containerWorkdir: "/workspace",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: { tools: { fs: { workspaceOnly: true } } },
      sessionKey: "session-key",
      workspaceDir: "/tmp/agent-workspace",
    });

    const result = await normalize({
      mediaUrls: ["../sandboxes/session-1/screens/final.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: path.resolve("/tmp/agent-workspace", "../sandboxes/session-1/screens/final.png"),
      mediaUrls: [
        path.resolve("/tmp/agent-workspace", "../sandboxes/session-1/screens/final.png"),
      ],
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("keeps managed generated media under the shared media root", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/Users/peter/.openclaw");
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
      mediaUrls: ["/Users/peter/.openclaw/media/tool-image-generation/generated.png"],
    });

    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/tool-image-generation/generated.png",
      mediaUrls: ["/Users/peter/.openclaw/media/tool-image-generation/generated.png"],
    });
    expect(saveMediaSource).not.toHaveBeenCalled();
  });

  it("passes through absolute file URLs without restriction", async () => {
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

  it("persists volatile agent-state media from the workspace into host outbound media", async () => {
    saveMediaSource.mockResolvedValue({
      path: "/Users/peter/.openclaw/media/outbound/persisted.png",
    });
    const normalize = createReplyMediaPathNormalizer({
      cfg: {},
      sessionKey: "session-key",
      workspaceDir: "/Users/peter/.openclaw/workspace",
    });

    const result = await normalize({
      mediaUrls: [
        "/Users/peter/.openclaw/workspace/.openclaw/media/tool-image-generation/generated.png",
      ],
    });

    expect(saveMediaSource).toHaveBeenCalledWith(
      "/Users/peter/.openclaw/workspace/.openclaw/media/tool-image-generation/generated.png",
      undefined,
      "outbound",
    );
    expect(result).toMatchObject({
      mediaUrl: "/Users/peter/.openclaw/media/outbound/persisted.png",
      mediaUrls: ["/Users/peter/.openclaw/media/outbound/persisted.png"],
    });
  });
});
