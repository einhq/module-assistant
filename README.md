# module-assistant

Assistant: answers questions by running EiN's commands for the user, with what the installed modules offer it.

An [EiN](https://github.com/einhq) module. It is developed and tested inside a checkout of EiN core,
as `modules/assistant`, and a deployment chooses whether to run it. `mod.json` is its manifest: the core it
needs (`coreApi`), the modules it depends on, and what it exports.

## What it holds

The chat drawer's backend (`assistant-ask`), which depends on core alone: a bounded loop in which Qwen3.5-4B, over the OpenAI chat API (`CFG_LLM_URL`: the `llm` container in production, or any compatible service), calls the commands the modules offer as native tools, described by their own specs, with its rules in `/etc/assistant-prompt.md` and what each module says of its part after them; cards under an answer, each a module's route; a change is a proposal the user runs from the drawer, recorded in the chat log (`assistant-chat outcome`). What a module offers it — `tools`, `prompt.md`, `cards.json`, `examples` and `eval.json` — is its drop-in, `etc/assistant.d/`, linked as `/etc/assistant.d/<module>/`. `llm-chat` (one question to the model, what `CFG_LANGUAGE_MODEL` names), the command finder (`assistant-commands`, with vectors from `CFG_TEXT_EMBEDDER`), and `llm-status` and the `llm-link` dashboard row: whose the model is (ours or a provider's, `CFG_LLM_PROVIDER`), where ours runs (`CFG_LLM_CARD`, the card's mode from `CFG_LLM_CARD_MODE`), whether it answers

## Architecture

- [chat.md](architecture/chat.md) — the chat drawer, the loop, the model it asks and the tools it calls
