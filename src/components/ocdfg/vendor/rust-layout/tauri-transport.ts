import { invoke } from "@tauri-apps/api/core";

/** Same shape as `@r4pm/components`' `VizTransport`: call a rust4pm visualization function by
 *  name with its JSON arguments. Upstream backs it with a wasm build of `process_mining`; ours is
 *  backed by the `viz_call` Tauri command (`src-tauri/src/lib.rs`), which runs the same
 *  `process_mining` version natively, so the same names and JSON work on both. Our own glue, not
 *  vendored. */
export interface VizTransport {
  call(fn: string, args: Record<string, unknown>): Promise<unknown>;
}

export const tauriVizTransport: VizTransport = {
  call: (name, args) => invoke("viz_call", { name, args }),
};
