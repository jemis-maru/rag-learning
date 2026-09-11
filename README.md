# 📚 Bookworm — a small RAG project

A book-recommendation chatbot that can only recommend books from a catalog
**you upload**. If a book isn't in the catalog, the bot won't invent it.

This is a learning project. It exists to show what **RAG** (Retrieval-Augmented
Generation) actually does: *search your own data first, then let the AI write
the answer using only what you found.*

Next.js (frontend) · Express (backend) · Google Gemini (AI)

---

## Two pages

| Page | Who | What |
|---|---|---|
| `/` | readers | Chat — ask for a book |
| `/admin` | you | Upload a catalog and watch it get processed |

---

## Setup

```bash
cd backend
cp .env.example .env      # paste a free key from https://aistudio.google.com/apikey
                          # and set ADMIN_TOKEN to any string you like
npm install

cd ../frontend
npm install
```

## Run (two terminals)

```bash
cd backend  && npm run dev     # http://localhost:4000
cd frontend && npm run dev     # http://localhost:3100
```

A fresh install has **no catalog on purpose** — loading one is the first thing
you do. Easiest way:

```bash
cd backend && npm run ingest fixtures/books-50.csv
```

Or do it through the UI at <http://localhost:3100/admin> (unlock with your
`ADMIN_TOKEN`, upload `backend/fixtures/books-50.csv`, click Publish).

Then open <http://localhost:3100> and ask for a book.

---

## The flow, with an example

### Part 1 — Loading the catalog (happens once, in `/admin`)

You upload a spreadsheet of books. It goes through four stages:

```
your CSV  ──▶  parse  ──▶  validate  ──▶  chunk  ──▶  embed  ──▶  activate
              (rows)      (good rows)   (text bits)  (vectors)   (goes live)
```

Take one row:

```csv
title,author,genres,readingLevel,pages,mood,description
Piranesi,Susanna Clarke,Fantasy; Mystery,advanced,272,"dreamlike, quiet","A man lives alone in an infinite house of statues..."
```

- **parse** — read the file into rows
- **validate** — `title`, `author` and `description` are required; a row missing one is
  dropped and reported, and the other 49 books still import
- **chunk** — turn the row into short text blobs to search over, e.g.
  `"Piranesi by Susanna Clarke / Mood: dreamlike, quiet / Summary: A man lives alone..."`
- **embed** — send each blob to Gemini, get back a list of numbers (a *vector*)
  that represents its meaning. Similar meanings → similar numbers.
- **activate** — the new catalog replaces the old one, and the chat starts using it

### Part 2 — Answering a question (every message on `/`)

A reader types:

> **"something dreamy and strange, and not too long"**

```
question ──▶ embed the question ──▶ compare to every book vector
                                            │
                                            ▼
                                    top 6 closest books
                                            │
                                            ▼
                            paste them into the prompt ──▶ Gemini writes the reply
```

1. **Embed the question** into numbers, the same way the books were embedded.
2. **Compare** it against every book vector and keep the closest 6.
   "dreamy and strange" lands near Piranesi's mood blob — even though the
   reader never typed the word "Piranesi" or "fantasy". That's the point of
   embeddings: matching on *meaning*, not on keywords.
3. **Build the prompt.** The 6 books get pasted in as text, with a rule on top:
   *"Recommend ONLY books from the catalog below. Never invent a title."*
4. **Gemini writes** a friendly answer using just those 6 books.

The reply names real books from your file, and the UI shows you which 6 books
were retrieved — so you can always see *why* it said what it said.

### What if nothing matches?

Ask *"what's the capital of Peru?"* and the closest book still isn't close
enough. There's a **relevance floor** (`MIN_SCORE`), and below it the bot gets
an empty catalog and honestly says it can't help — instead of confidently
recommending six unrelated novels.

---

## Why RAG instead of just asking the AI?

| Plain AI | This project |
|---|---|
| Recommends books it half-remembers | Recommends only books you stock |
| Can invent titles that don't exist | Can't — it's only shown your catalog |
| Doesn't know your new arrivals | Re-upload the file and it does |

---

## Things worth playing with

Set these in `backend/.env`, restart the backend, and see what changes:

| Setting | Try it |
|---|---|
| `MIN_SCORE=0.58` | Lower it to `0.2` and ask an off-topic question — the bot starts recommending nonsense. That's the floor earning its keep. |
| `RETRIEVE_K=6` | How many books get pasted into the prompt. Try `1` or `15`. |
| `CHUNK_STRATEGY=field-split` | `whole-record` = one blob per book. `field-split` = a facts blob + a mood blob, which matches mood questions better. |
| `ENABLE_QUERY_REWRITE=true` | Turns a follow-up like *"something shorter?"* into a real search query. Turn it off and follow-ups get worse. |

Also try `POST /api/search` on the backend — it does the retrieval step only,
so you can see what the search finds without spending AI tokens on an answer.

---

## Where things live

```
backend/
  src/server.js          the API routes
  src/rag.js             ⭐ the whole RAG flow: rewrite → retrieve → prompt → answer
  src/vectorStore.js     ⭐ the search: compares vectors, applies the relevance floor
  src/gemini.js          the two AI calls (embed text / write answer)
  src/pipeline/          parse → validate → chunk → embed
  src/ingest.js          the `npm run ingest` command
  fixtures/              sample catalogs to upload

frontend/
  app/page.js            the chat page
  app/admin/page.js      the upload + pipeline page
  app/api/               thin proxies, so the browser never sees your keys
```

Start with `rag.js` and `vectorStore.js` — that's the actual RAG part. Everything
else is plumbing around it.

---

## If something breaks

| Symptom | Fix |
|---|---|
| "No catalog is loaded yet" | Run `npm run ingest fixtures/books-50.csv` in `backend/` |
| "GEMINI_API_KEY is missing" | Copy `backend/.env.example` to `backend/.env` and paste your key |
| "Cannot reach the backend" | The backend terminal isn't running |
| Admin page says 503 | `ADMIN_TOKEN` isn't set in `backend/.env` |
| Port already in use | Change `PORT` in `backend/.env`, or the `-p` flag in `frontend/package.json` |
