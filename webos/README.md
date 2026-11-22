# ClothCraft browser workspace

The WebOS app uses ClothCraft's Rust garment editor transactions, native JSON
templates, and CPU VBD/OGC solver. Its dedicated browser worker owns the loaded
garment and solver state. The pattern board shows rest geometry. The drape pane
shows simulated mesh positions around the bundled MakeHuman mannequin.

Use Open, Save, and Save as through WebOS Files. The saved `.clothcraft.json`
document is a native garment template with editable contours, placements, and
seams. A reopened garment starts a fresh simulation. The browser uses the
bundled mannequin and supports the CPU stepping controls. Start with a T-shirt
or dress from the template menu. The browser uses coarser meshes for these
starting templates to keep interactive CPU stepping viable.

Build the source using the repository lock and wasm-bindgen 0.2.129.

```sh
cargo build --locked --no-default-features --features web --target wasm32-unknown-unknown --lib --release -j 2
wasm-bindgen --target web --no-typescript --out-dir /path/to/wasm --out-name clothcraft /path/to/target/wasm32-unknown-unknown/release/marvelous_cloth.wasm
python3 webos/package.py /path/to/wasm /path/to/new-site
```

Pass the receipt-bound package to the WebOS builder using
`--clothcraft-site /path/to/new-site`. The package includes the app license
and the MakeHuman asset notices.
