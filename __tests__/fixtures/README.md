# Golden frames

Bytes produced by the C++ engine's own encoder:

```sh
engine/build/engine --emit-fixtures __tests__/fixtures
```

`frames.test.js` decodes them with the JavaScript codec in `driver/frames.js`.
That is the only thing keeping the two implementations of the frame format
honest with each other — a header field silently moved on one side shows up
here as a decode failure rather than as a trace that is wrong by one cell.
