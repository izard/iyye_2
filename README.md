# Iyye: A Resident Agentic Assistant

Iyye is a personal, local-first AI assistant designed to exist as an integrated part of your computing environment rather than a distant service.
Named after the Chuvash home deity, she is built on the principle that true utility comes from presence, continuity, and deep integration with your local tools and hardware.

## 🏗️ The Architecture of Presence

Iyye's intelligence is an orchestration of the following components:

| Component | Role | Functionality |
| :--- | :--- | :--- |
| **Hindsight** | **Memory & Continuity** | Implements a hierarchical memory system—spanning immediate conversation context, procedural tool awareness, and long-term episodic storage to ensure continuity through time. |
| **KEV** | **Personality & Temperament** | Governs personality decisions, managing the nuances of tone, wit, and social presence to maintain warm, candid, and contextually appropriate interactions. |
| **Pi** | **The Orchestration Layer** | The central agentic harness (the "prefrontal cortex") that receives high-level intent, decomposes requests into actionable plans, and orchestrates tool/model calls. |

### 🛠️ Specialized Intelligence (Multi-Model Routing)
Iyye does not rely on a single model for all tasks. Instead, she routes queries to an optimized ensemble of local models:
* **Reasoning & Complex Logic:** High-parameter reasoning models via `ask_thinking_model`.
* **Chat & Interaction:** Lightweight, low-latency models for seamless Telegram and web communication.
* **Background Tasks:** Small, efficient models (e.g., Qwen) managing continuous monitoring and system housekeeping.

## 🏠 Why Local?

By running on your own hardware, Iyye provides:

1.  **Privacy by Design:** Your data and conversations never leave your machine to train a third-party model.
2.  **Deep System Agency:** Direct, secure access to Git repositories, system telemetry, and local filesystems.
3.  **Zero Latency Identity:** A resident assistant that is always awake (excepts when it sleeps), always aware of your system state, and uniquely yours.
