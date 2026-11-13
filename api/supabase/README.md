index.html        the whole app (one file)
api/verify.js     Vercel serverless function: confirms a Stripe purchase, and a setup check
vendor/           MP3 encoder (lamejs, LGPL-3.0) and MP4 muxer (mp4-muxer, MIT), inlined into index.html
js/dsp.js         measurement engine for the Hit Potential report (also inlined)
tests/            unit tests (DSP and payment verification)
index.html        the live app. Edit it directly. build.py is retired: rebuilding would overwrite the live Stripe and Brevo settings.
