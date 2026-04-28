import path from "node:path";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolvePathFromInput } from "../../agents/path-policy.js";
import { assertMediaNotDataUrl } from "../../agents/sandbox-paths.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { isPassThroughRemoteMediaSource } from "../../media/media-source-url.js";
import { saveMediaSource } from "../../media/store.js";
import { resolveConfigDir } from "../../utils.js";
import type { ReplyPayload } from "../types.js";

const FILE_URL_RE = /^file:\/\//i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT_RE = /\.\w{1,10}$/;
const AGENT_STATE_MEDIA_DIRNAME = path.join(".openclaw", "media");
const MANAGED_GLOBAL_MEDIA_SUBDIRS = new Set(["outbound"]);

function isLikelyLocalMediaSource(media: string): boolean {
  return (
    FILE_URL_RE.test(media) ||
    media.startsWith("/") ||
    media.startsWith("./") ||
    media.startsWith("../") ||
    media.startsWith("~") ||
    WINDOWS_DRIVE_RE.test(media) ||
    media.startsWith("\\\\") ||
    (!SCHEME_RE.test(media) &&
      (media.includes("/") || media.includes("\\") || HAS_FILE_EXT_RE.test(media)))
  );
}

function getPayloadMediaList(payload: ReplyPayload): string[] {
  return resolveSendableOutboundReplyParts(payload).mediaUrls;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isManagedGlobalReplyMediaPath(candidate: string): boolean {
  const globalMediaRoot = path.join(resolveConfigDir(), "media");
  const relative = path.relative(path.resolve(globalMediaRoot), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const firstSegment = relative.split(path.sep)[0] ?? "";
  return MANAGED_GLOBAL_MEDIA_SUBDIRS.has(firstSegment) || firstSegment.startsWith("tool-");
}

function isAllowedAbsoluteReplyMediaPath(params: {
  candidate: string;
  workspaceDir: string;
  sandboxRoot?: string;
}): boolean {
  if (isManagedGlobalReplyMediaPath(params.candidate)) {
    return true;
  }
  const volatileRoots = [params.workspaceDir, params.sandboxRoot]
    .filter((root): root is string => Boolean(root))
    .map((root) => path.join(path.resolve(root), AGENT_STATE_MEDIA_DIRNAME));
  return volatileRoots.some((root) => isPathInside(root, params.candidate));
}

export function createReplyMediaPathNormalizer(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  workspaceDir: string;
  messageProvider?: string;
  accountId?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  requesterSenderId?: string;
  requesterSenderName?: string;
  requesterSenderUsername?: string;
  requesterSenderE164?: string;
}): (payload: ReplyPayload) => Promise<ReplyPayload> {
  let sandboxRootPromise: Promise<string | undefined> | undefined;
  const persistedMediaBySource = new Map<string, Promise<string>>();

  const resolveSandboxRoot = async (): Promise<string | undefined> => {
    if (!sandboxRootPromise) {
      sandboxRootPromise = ensureSandboxWorkspaceForSession({
        config: params.cfg,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
      }).then((sandbox) => sandbox?.workspaceDir);
    }
    return await sandboxRootPromise;
  };

  const persistVolatileAgentMedia = async (media: string): Promise<string> => {
    if (!path.isAbsolute(media)) {
      return media;
    }
    const sandboxRoot = await resolveSandboxRoot();
    if (
      !isAllowedAbsoluteReplyMediaPath({
        candidate: media,
        workspaceDir: params.workspaceDir,
        sandboxRoot,
      })
    ) {
      return media;
    }
    const volatileRoots = [params.workspaceDir, sandboxRoot]
      .filter((root): root is string => Boolean(root))
      .map((root) => path.join(path.resolve(root), AGENT_STATE_MEDIA_DIRNAME));
    if (!volatileRoots.some((root) => isPathInside(root, media))) {
      return media;
    }
    const cached = persistedMediaBySource.get(media);
    if (cached) {
      return await cached;
    }
    const persistPromise = saveMediaSource(media, undefined, "outbound")
      .then((saved) => saved.path)
      .catch((err) => {
        persistedMediaBySource.delete(media);
        throw err;
      });
    persistedMediaBySource.set(media, persistPromise);
    try {
      return await persistPromise;
    } catch (err) {
      logVerbose(`failed to persist volatile reply media ${media}: ${String(err)}`);
      return media;
    }
  };

  const normalizeMediaSource = async (raw: string): Promise<string> => {
    const media = raw.trim();
    if (!media) {
      return media;
    }
    assertMediaNotDataUrl(media);
    if (isPassThroughRemoteMediaSource(media)) {
      return media;
    }
    // the agent already has filesystem access via tools, path restrictions
    // here only cause silent drops that confuse both the model and the user
    if (!path.isAbsolute(media) && isLikelyLocalMediaSource(media) && !FILE_URL_RE.test(media)) {
      return resolvePathFromInput(media, params.workspaceDir);
    }
    return media;
  };

  return async (payload) => {
    const mediaList = getPayloadMediaList(payload);
    if (mediaList.length === 0) {
      return payload;
    }

    const normalizedMedia: string[] = [];
    const seen = new Set<string>();
    for (const media of mediaList) {
      let normalized: string;
      try {
        normalized = await persistVolatileAgentMedia(await normalizeMediaSource(media));
      } catch (err) {
        logVerbose(`dropping blocked reply media ${media}: ${String(err)}`);
        continue;
      }
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      normalizedMedia.push(normalized);
    }

    if (normalizedMedia.length === 0) {
      return {
        ...payload,
        mediaUrl: undefined,
        mediaUrls: undefined,
      };
    }

    return {
      ...payload,
      mediaUrl: normalizedMedia[0],
      mediaUrls: normalizedMedia,
    };
  };
}

export type ReplyMediaContext = {
  normalizePayload: (payload: ReplyPayload) => Promise<ReplyPayload>;
};

export function createReplyMediaContext(
  params: Parameters<typeof createReplyMediaPathNormalizer>[0],
): ReplyMediaContext {
  return {
    normalizePayload: createReplyMediaPathNormalizer(params),
  };
}
