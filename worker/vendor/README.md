# Image validation dependencies

`image-decode.mjs` is a checked-in browser-platform ESM bundle of `image-decode-entry.mjs`, jpeg-js 0.4.4 and fflate 0.8.2. The adjacent MIT license files cover those dependencies. The browser's `src/vendor/fflate.js` is the unmodified fflate 0.8.2 UMD distribution, bundled into the app and its archive worker; no runtime CDN is required.

To rebuild using a temporary dependency directory:

```sh
npm install --prefix /tmp/wordlab-media-vendor --no-audit --no-fund fflate@0.8.2 jpeg-js@0.4.4 esbuild@0.25.12
NODE_PATH=/tmp/wordlab-media-vendor/node_modules /tmp/wordlab-media-vendor/node_modules/.bin/esbuild worker/vendor/image-decode-entry.mjs --bundle --minify --format=esm --platform=browser --outfile=worker/vendor/image-decode.mjs
```

Run the full application/Worker tests after rebuilding. Application builds consume the checked-in files and do not install these dependencies.
