# woolgather typefaces

Self-hosted WOFF2 fonts. Each typeface retains its SIL Open Font License notice; the app makes no third-party font requests.

- [Geist](https://www.npmjs.com/package/geist), official package version 1.7.2: interface, controls and headings, variable weights 100–900. Unmodified `dist/fonts/geist-sans/Geist-Variable.woff2`, retrieved September 13, 2026. Copyright Vercel, in collaboration with basement.studio. Complete license: `Geist-OFL.txt`.
- [Source Serif 4](https://github.com/adobe-fonts/source-serif): sustained reading and welcome headlines, weights 400–700, Latin and Latin Extended. Google Fonts distribution, September 13, 2026; included OFL notice.
- [Inter 4.1](https://rsms.me/inter/): previous interface font, retained as provenance with `Inter-OFL.txt`. It is no longer the active interface family. Instrument Sans is also a historical candidate.

Declarations live in `src/ui/fonts.css`. Geist and the Latin reading face are preloaded; italic and extended reading faces load when used. `check:ui` verifies that the preloaded interface face matches the active family token.
