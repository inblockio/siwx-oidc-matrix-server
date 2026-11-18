// The audio recorder's MP3 encoder worker (B6): Rocket.Chat ships it as a public asset (`/workers/mp3-encoder/index.js`, built
// from @rocket.chat/mp3-encoder), which the kit has no server for. Webpack bundles it as a worker chunk of the kit instead.
import 'rc-mp3-encoder';
