import { invoke } from "@tauri-apps/api/core";
import type { GraphLayout, LayoutTransport } from "./index";

/** Our own glue, not vendored: propel backs `LayoutTransport` with a WASM module loaded
 *  in-browser; we're a Tauri app with a real native Rust backend, so this backs it with the
 *  `layout_graph`/`reroute_graph` commands (`src-tauri/src/lib.rs`) instead — same crate, called
 *  over IPC rather than WASM. */
export const tauriLayoutTransport: LayoutTransport = {
  layoutGraph: (spec) => invoke<GraphLayout>("layout_graph", { spec }),
  rerouteGraph: (spec) => invoke<GraphLayout>("reroute_graph", { spec }),
};
