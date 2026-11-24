# Credits

The pigeons, bread, crumbs, bench, trees, hedges, lamp post, grass, sky dome, icons and loading pigeon are all drawn in code for this project. The only outside assets are listed below. All are CC0 or public domain.

## Scene assets

All third-party assets used by `src/scene/` come from [Poly Haven](https://polyhaven.com) and are licensed **CC0 1.0** (public domain). They live in `public/assets/scene/`. Everything else in the park (bench, trees, hedges, lamp post, grass blades, sky dome, loading pigeon) is drawn in code.

| File | Asset | Source URL | License |
| --- | --- | --- | --- |
| `sky_1k.hdr` | Kloofendal 48d Partly Cloudy (Pure Sky), 1k HDR | https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky (file: https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloofendal_48d_partly_cloudy_puresky_1k.hdr) | CC0 |
| `paving_diff_1k.jpg` | Rectangular Paving, diffuse 1k | https://polyhaven.com/a/rectangular_paving (file: https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/rectangular_paving/rectangular_paving_diff_1k.jpg) | CC0 |
| `paving_nor_1k.jpg` | Rectangular Paving, normal (GL) 1k | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/rectangular_paving/rectangular_paving_nor_gl_1k.jpg | CC0 |
| `grass_diff_1k.jpg` | Aerial Grass Rock, diffuse 1k | https://polyhaven.com/a/aerial_grass_rock (file: https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/aerial_grass_rock/aerial_grass_rock_diff_1k.jpg) | CC0 |
| `wood_diff_1k.jpg` | Wood Table 001, diffuse 1k | https://polyhaven.com/a/wood_table_001 (file: https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/wood_table_001/wood_table_001_diff_1k.jpg) | CC0 |
| `wood_nor_1k.jpg` | Wood Table 001, normal (GL) 1k | https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/wood_table_001/wood_table_001_nor_gl_1k.jpg | CC0 |

Total download: about 3.5 MB.

### Audio

### Recordings

| File | Source | Author | License |
| --- | --- | --- | --- |
| `public/assets/audio/dove-coo.ogg` | https://commons.wikimedia.org/wiki/File:Dove_cooing.ogg (originally PDSounds.org record 503, http://www.pdsounds.org/sounds/dove_cooing) | mary905 | Public domain ({{PD-author\|mary905}} on the Commons file page) |

Used unmodified (50 KB, 7.9 s, Ogg Vorbis). The page splits it into individual coos at runtime and varies their pitch. The Commons file page categorises it as a Barbary dove (*Streptopelia risoria*), a close cousin of the feral pigeon.

### Synthesized

No public-domain or CC0 wing-flap recording could be found that downloads without a login, so the wing flaps are synthesized in Web Audio, as are the crumb toss, the landing tick, the peck, and the fallback coo used when a browser can't decode Ogg Vorbis. See `src/audio/index.ts`.

## Fallback image

`public/fallback.jpg` is a screenshot of this project's own park scene.
