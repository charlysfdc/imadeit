pdf.js 6.4.299 (legacy build) from the pdfjs-dist npm package, Apache License 2.0 (see LICENSE).
Used to read pattern PDFs on the device. Nothing is uploaded.
stream-iterator-shim.mjs and pdf.worker.shim.mjs are ImadeIt's own: they add the ReadableStream async iterator
that Safari lacks (pdf.js reads page text with `for await`), in the page and in the worker.
