import registerViewed from "./viewed/index";
import { BUILT_IN_SOURCE_PREFIX, type BuiltInExtension } from "../host";

/**
 * User-tier extensions compiled into junk. Each loads under its own id through the normal
 * extension path, so panes, file views, keyboard modes, transforms and events all work, and an
 * installed copy of the same id is refused with a pointer to `hunk extension remove`.
 */
export const JUNK_BUILT_IN_EXTENSIONS: readonly BuiltInExtension[] = [
  {
    id: "hunk-viewed",
    factory: registerViewed,
    sourcePath: `${BUILT_IN_SOURCE_PREFIX}hunk-viewed`,
  },
];
