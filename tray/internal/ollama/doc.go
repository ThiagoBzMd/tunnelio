// Package ollama is the ONLY place that talks to the local Ollama server.
//
// Fixed table (SPEC §8.1) — one exported method per endpoint, nothing generic:
//
//	Version(ctx)                        GET  /api/version
//	ListModels(ctx)                     GET  /api/tags
//	ListRunning(ctx)                    GET  /api/ps
//	ShowModel(ctx, name)                POST /api/show
//	Chat(ctx, req, onChunk)             POST /api/chat   (stream:true; never tools/format/template/raw;
//	                                                     images only inside user messages, validated)
//	Pull(ctx, name, onProgress)         POST /api/pull   (stream:true; never insecure)
//	Delete(ctx, name)                   DELETE /api/delete
//
// /api/create, /api/push, /api/copy, /api/generate, /api/embed, /api/blobs are intentionally
// absent. The base URL comes from config and must be a loopback host unless changed from the
// local tray menu. Model names are validated with the regexes in SPEC §8.2; chat options with
// the whitelist in SPEC §8.3; chat images by magic bytes (JPEG/PNG/WebP/GIF only), count
// (MaxImagesPerMessage) and size (MaxImageBytes), and only on user messages. Ollama's JSON is
// decoded into named structs and never relayed.
package ollama
