# 📚 Bookworm — Book Recommendation Chatbot (RAG)

A chatbot that suggests books from your own catalog file
(`backend/src/data/books.json`, 50 books) instead of making them up.

Next.js (frontend) · Express (backend) · Google Gemini (AI)

---

## Setup

```bash
cd backend
cp .env.example .env      # paste your key from https://aistudio.google.com/apikey
npm install

cd ../frontend
npm install
```

## Run (two terminals)

```bash
cd backend  && npm run dev     # http://localhost:4000
cd frontend && npm run dev     # http://localhost:3000
```

Open <http://localhost:3000>.

---

## What happens when you send a message

**In one paragraph:**

> We generate a vector of all books using Gemini. When the user sends a message
> in chat, we get a vector of it using Gemini too. Then we compare both vectors
> **without Gemini, locally in our own code**. After comparing, we find the 6
> closest books with a score. Then we send those 6 books to Gemini to generate
> the formatted response.

That's the whole thing. Two details worth knowing:

- The book vectors are generated **once** and saved to a file — not on every
  message.
- We send Gemini only the **6 winners**, never all 50. Trimming 50 down to 6 is
  the entire job of the comparison step.

Which parts actually call Gemini:

| Step | Gemini? |
|---|---|
| Vectors for all 50 books | yes — once at startup, then cached |
| Vector for your message | yes — every message |
| Comparing vectors, ranking, picking 6 | **no — our own code, no network** |
| Writing the formatted answer from those 6 | yes — every message |

So **2 Gemini calls per message** (3 for a follow-up like *"something shorter?"*,
which needs one extra call to rewrite it into a standalone question first).

The rest of this section is the same thing with a real example.

---

Say you type:

```
cozy fantasy, nothing violent please
```

### Step 1 — We search our own JSON file (no AI writing yet)

The AI has never seen `books.json`. So **our code** finds the matching books
first.

We can't just match words — your message doesn't contain the word "Legends" or
"orc". We need to match **meaning**. That works like this:

- **Once, when the server starts:** each of the 50 books in `books.json` is sent
  to Gemini and comes back as a list of 768 numbers. Think of it as a
  *fingerprint of what that book is about*. Books about similar things get
  similar fingerprints. These are saved to a file, so this only happens once.

- **When you send a message:** your message gets a fingerprint the same way.

- Then we compare your fingerprint against all 50 book fingerprints and keep the
  **6 closest matches**.

For this message the 6 winners were:

```
Legends and Lattes  ·  The House in the Cerulean Sea  ·  A Wizard of Earthsea
The Hobbit  ·  The Midnight Library  ·  The Name of the Wind
```

Notice *Legends and Lattes* won even though your message shares no words with its
title or summary. Its fingerprint says "gentle, low-stakes fantasy", and so does
yours. **That's the part plain keyword search can't do.**

### Step 2 — We paste those 6 books into the question for the AI

Now we build the message we send to Gemini. It's the rules, plus the 6 books we
just found, copied straight out of `books.json`:

```
You are Bookworm, a book recommendation assistant.
- Recommend ONLY books from the CATALOG below. Never invent a title or detail.
- For each: title, author, why it fits, genre, reading level, page count.

=========== CATALOG (the only books you may recommend) ===========

Title: Legends and Lattes
Author: Travis Baldree (2022)
Genres: Fantasy, Cozy
Reading level: beginner
Length: 302 pages
Mood and style: cozy, gentle, charming
Summary: A retired orc barbarian hangs up her sword to open the city's first
  coffee shop. Low-stakes cozy fantasy about building something instead of
  destroying it.

Title: The House in the Cerulean Sea
... (4 more books)
```

Then your actual message, `"cozy fantasy, nothing violent please"`, is sent along
with it.

**This is the whole trick.** The AI isn't remembering books — it's reading a list
we handed it a moment ago, and the line *"Recommend ONLY books from the CATALOG"*
is what stops it inventing anything.

### Step 3 — The AI writes the reply

Gemini turns those 6 records into a friendly answer:

> You asked for cozy fantasy with zero violence, so I have two delightfully
> peaceful, low-stakes reads that are all about warmth, comfort, and heart!
>
> **Legends and Lattes** by Travis Baldree
> Since you want a gentle story free from battles and bloodshed, this low-stakes
> cozy fantasy is a perfect fit. It follows a retired orc barbarian who puts away
> her sword for good to open the very first coffee shop in a fantasy city...
> * **Genre:** Cozy Fantasy
> * **Reading Level:** Beginner
> * **Length:** 302 pages
>
> **The House in the Cerulean Sea** by TJ Klune ...

*(That is a real reply, trimmed.)*

Look at **"302 pages"** and **"Beginner"**. The AI did not know those. It read
them in the text we pasted in Step 2 — which came from `books.json`.

**The AI chose the words. Your JSON file supplied the facts.**

---

## The short version

```
your message
    │
    ├─ 1. our code finds the 6 books in books.json that match its meaning
    │
    ├─ 2. we paste those 6 books into the prompt: "only recommend these"
    │
    └─ 3. Gemini writes the answer using only those 6

                          ↓
        answer + the 6 books it was given (shown in the UI)
```

The chat window shows a **"Retrieved 6 catalog entries"** link under every answer,
so you can see exactly which books the AI was given.

---

## Adding your own books

Add entries to `backend/src/data/books.json` — keep all the fields, because all
of them are used to build the fingerprint in Step 1:

```json
{
  "id": "b051",
  "title": "…",
  "author": "…",
  "year": 2024,
  "genres": ["Fantasy"],
  "readingLevel": "beginner",
  "pages": 400,
  "themes": ["…"],
  "mood": "cozy, funny",
  "description": "What happens, and who would enjoy it.",
  "similarTo": ["…"]
}
```

Then rebuild the fingerprints:

```bash
cd backend && npm run ingest
```

---

## If something breaks

| Message | Fix |
|---|---|
| `GEMINI_API_KEY is missing` | create `backend/.env` and paste your key |
| `Backend unreachable` in the sidebar | the backend isn't running on port 4000 |
| `429` / `RESOURCE_EXHAUSTED` | free daily limit used up. Quota is **per model**, so change `CHAT_MODEL` in `.env` (e.g. `gemini-3.5-flash-lite`) to keep going |
| `404 ... no longer available` | Google retired that model. Change `CHAT_MODEL` or `EMBED_MODEL` in `.env` |
| `port 4000 is already in use` | another copy is running — stop it, or set `PORT=4001` |

**Note:** values in `backend/.env` override the defaults in the code, so a stale
model name there keeps failing until you edit it.

---

## Files

```
backend/src/
  data/books.json    ← your catalog (the source of every fact in an answer)
  vectorStore.js     ← Step 1: fingerprints + finding the 6 closest books
  rag.js             ← Step 2: builds the prompt with those books in it
  gemini.js          ← the two calls to Gemini (fingerprints, and writing)
  server.js          ← Express routes
frontend/app/
  page.js            ← chat window
```
