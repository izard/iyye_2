---
description: Describe a camera frame in plain text for the sensor queue (multimodal)
variables:
  image_base64: Base64-encoded image (passed as message content, not template variable)
  context_hint: Optional hint about what to look for (e.g. "monitor screen", "room overview")
---

Describe what you see in this image in 1-3 sentences. Be factual and specific. Focus on: what objects are present, any text visible, the spatial layout, and anything that looks like it changed since a typical idle state.

{context_hint}
