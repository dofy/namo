# Bundled fonts

## JetBrains Mono

Latin text and numbers in the Namo workbench use the locally bundled
JetBrains Mono variable font (weights 100–800). Chinese characters fall back
to PingFang SC / Microsoft YaHei.

- Font project: https://github.com/JetBrains/JetBrainsMono
- Google Fonts metadata: https://github.com/google/fonts/blob/main/ofl/jetbrainsmono/METADATA.pb
- Downloaded 2026-10-26 from the Google Fonts CSS API (JetBrains Mono v24, Latin subset).
- Font binary: https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbV2o-flEEny0FZhsfKu5WU4xD7OwGtT0rU.woff2
- License: SIL Open Font License 1.1; see `JetBrainsMono-OFL.txt`.

`ui/fonts/jetbrains-mono-latin.woff2` is emitted into `dist/ui/assets` by Vite.
The application does not contact Google Fonts at runtime.

## Caveat

The Namo wordmark uses Caveat Medium (500), a handwriting typeface.

- Font project: https://github.com/googlefonts/caveat
- Google Fonts metadata: https://github.com/google/fonts/blob/main/ofl/caveat/METADATA.pb
- Downloaded 2026-10-26 from the Google Fonts CSS API (Caveat v23, Latin subset).
- Font binary: https://fonts.gstatic.com/s/caveat/v23/WnznHAc5bAfYB2QRah7pcpNvOx-pjcB9eIWpYT5Kmgq3sw.woff2
- Local file: `ui/fonts/caveat-latin-500.woff2`.
- License: SIL Open Font License 1.1; see `Caveat-OFL.txt`.

Both fonts are bundled and loaded locally; no runtime font service is used.
