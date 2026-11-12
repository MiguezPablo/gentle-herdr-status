# Twemoji assets

The SVG files in this directory are the Twemoji graphics for the emoji the screenshot
generator draws inline. Inlining them means every viewer (GitHub, npm, a local browser)
shows the same glyph, without an emoji font, an external image or a network request.

- Source: [jdecked/twemoji](https://github.com/jdecked/twemoji), the maintained fork of
  Twitter's Twemoji.
- Version: **v17.0.3**, downloaded from
  `https://cdn.jsdelivr.net/gh/jdecked/twemoji@v17.0.3/assets/svg/<codepoint>.svg`.
- License: the graphics are **CC-BY 4.0**
  (https://creativecommons.org/licenses/by/4.0/).
- Attribution: emoji graphics © Twitter, Inc and other contributors,
  https://twemoji.twitter.com/.

The files are the served assets unmodified: no XML prolog, each keeping Twemoji's
`viewBox="0 0 36 36"`. The generator only reads them; it never downloads anything.
