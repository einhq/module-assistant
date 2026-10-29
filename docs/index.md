# Assistant

The chat: ask the archive a question in words, and the assistant looks it up with the
archive's own commands and answers.

## Where the chat's questions go

The chat's answers come from a language model, which usually runs on the same
machine as EiN: nothing you ask leaves it. An installation can use a provider's
model instead, such as OpenAI's. The chat then names the provider above the box
you type in, because your questions, and the names, places and search results
the assistant reads in the archive to answer them, are sent there.

With the archive module, the same model also reads what is typed into the search
box, to find the people, places and years in it, so with a provider's model those
words are sent there too.

How to use the chat is in the full documentation, at
<https://einhq.eu/docs/assistant/chat.html>, and how to choose and run its model at
<https://einhq.eu/docs/assistant/language-model.html>.
