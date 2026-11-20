# Probe contracts

Each directory is a contract the emitter must treat in one way: `main.tsp` with `refuse.txt` is refused with a diagnostic holding that text;
without it the contract is emitted, compiled together with all the others, and its `document()` is built (`just probes`). `module.txt`, when
there, names the Rust module of the service whose `document()` is called (default `probe`).
