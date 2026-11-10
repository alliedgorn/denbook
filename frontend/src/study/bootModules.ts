// AI engineer bootcamp (T#967): hands-on track, local models first (Ollama).
// Module content is typed data rendered by RichText; no HTML anywhere.

import type { BootModule, PlannedModule } from './types';

export const BOOT_MODULES: BootModule[] = [
  {
    id: 'llm-basics',
    name: 'How LLMs actually work',
    week: 'Week 1',
    lede: 'Before RAG, agents or anything fancy: what really happens when you send a prompt. You run a model on your own laptop and call it from your own Python.',
    concepts: [
      {
        t: 'Tokens, not words',
        b: [
          { p: ['A model never sees text. It sees ', { term: 'tokens' }, ': chunks of characters from a fixed vocabulary. In English, one token is roughly 4 characters, about three quarters of a word.'] },
          { ul: [
            ['Everything is counted in tokens: the context limit, speed, and (on hosted APIs) the price.'],
            ['Thai and Chinese usually cost more tokens per character than English, so the same message is "bigger".'],
            ['Spelling and counting letters are hard for models because they never see the letters, only token IDs.'],
          ] },
        ],
        say: 'Models read and write tokens, not words, so I budget context and cost in tokens and expect weakness on character-level tasks.',
      },
      {
        t: 'Next-token prediction is the whole trick',
        b: [
          { p: ['Given all the tokens so far, the model outputs a probability for every possible next token. Generation is a loop: pick one token, append it, run again.'] },
          { ul: [
            ['That loop is why output streams in word by word.'],
            ['The model optimises for ', { b: 'plausible' }, ', not ', { b: 'true' }, '. A fluent wrong answer is the normal failure, not a rare glitch. That is a hallucination.'],
            ['It has no live access to facts. Anything after its training data, or private to your company, has to be put in the prompt. That is why RAG exists.'],
          ] },
        ],
        say: 'An LLM predicts the next token from probabilities, so it produces plausible text, not verified facts. Grounding and evals are how we make it trustworthy.',
      },
      {
        t: 'The context window, and why the model "forgets"',
        b: [
          { p: ['The ', { term: 'context window' }, ' is everything the model can see in one call: system prompt, conversation history, documents, tool results, and its own answer.'] },
          { ul: [
            [{ b: 'The model is stateless.' }, ' Every call starts from zero. A chat "remembers" only because your code resends the whole history each time.'],
            ['So long chats get slower and more expensive, and when history passes the limit, something has to be trimmed or summarised. That is your design decision, not the model\'s.'],
            ['Models also attend unevenly over very long contexts. Information buried in the middle can be missed.'],
          ] },
        ],
        say: 'The model is stateless; memory is something my application manages by choosing what goes back into the context window each turn.',
      },
      {
        t: 'Sampling: temperature and friends',
        b: [
          { p: [{ term: 'Temperature' }, ' reshapes the probabilities before a token is picked. Low (0 to 0.3) means it almost always picks the top token: focused and repeatable. High (0.8 and up) gives more variety and more risk.'] },
          { ul: [
            ['Extraction, classification, code: low temperature.'],
            ['Brainstorming, creative writing: higher.'],
            [{ term: 'top_p' }, ' and ', { term: 'top_k' }, ' cut off the unlikely tail. Change one knob at a time.'],
            ['Temperature 0 is close to deterministic, but not guaranteed identical every run. Never build a system that assumes it is.'],
          ] },
        ],
        say: 'I set temperature by task: low for anything that must be consistent, like extraction, and higher only where variety helps.',
      },
      {
        t: 'Anatomy of a chat call',
        b: [
          { p: ['Every chat API, local or hosted, has the same shape:'] },
          { ul: [
            [{ b: 'messages' }, ': a list of turns, each with a role (system, user, assistant) and content.'],
            [{ b: 'model' }, ' and ', { b: 'options' }, ': which model, temperature, max output length.'],
            [{ b: 'response' }, ': the text, why it stopped (finished, or hit the length limit), and token counts for input and output.'],
          ] },
          { p: ['With Ollama in Python it looks like this:'] },
          { code: 'import ollama\n\nresp = ollama.chat(\n    model="qwen3:8b",\n    messages=[{"role": "user", "content": "Explain RAG in one sentence."}],\n    options={"temperature": 0.2},\n)\nprint(resp["message"]["content"])\nprint("in:", resp["prompt_eval_count"], "out:", resp["eval_count"], "stop:", resp["done_reason"])' },
          { tip: ['Learn this shape once and every provider (Anthropic, OpenAI, Gemini, local) is a small translation.'] },
        ],
        say: 'Under every framework it is the same call: a list of role-tagged messages in, text plus a stop reason and token usage out.',
      },
      {
        t: 'What models are bad at, and what we do about it',
        b: [
          { ul: [
            [{ b: 'Fresh or private facts' }, ' → put them in the context (RAG).'],
            [{ b: 'Exact maths, counting, dates' }, ' → give it a tool (a calculator, code, an API) instead of trusting it.'],
            [{ b: 'Consistent structure' }, ' → ask for JSON, validate it in code, and retry on failure.'],
            [{ b: 'Taking actions' }, ' → tools with permission checks (agents, later).'],
          ] },
          { p: ['Almost every AI-engineering pattern you will learn is a fix for one of these four.'] },
        ],
        say: 'Most AI engineering is compensating for known model weaknesses: grounding for facts, tools for exactness, validation for structure, and guarded tools for actions.',
      },
    ],
    labs: [
      {
        t: 'Your first model call',
        day: 'Day 1',
        goal: 'A real Python project on your laptop that calls a local model and prints the answer plus token counts.',
        steps: [
          { ul: [
            ['Install Ollama from ollama.com, then in Terminal: ', { b: 'ollama pull qwen3:8b' }, ' and try ', { b: 'ollama run qwen3:8b' }, ' once by hand.'],
            ['Make a folder ', { b: 'ai-bootcamp' }, ', then run git init in it.'],
            ['Create a virtual environment and install the client:'],
          ] },
          { code: 'python3 -m venv .venv\nsource .venv/bin/activate\npip install ollama\necho ".venv/" >> .gitignore' },
          { p: ['Write ', { b: 'hello.py' }, ' yourself, using the call shape from the "Anatomy of a chat call" lesson. Make it take the question from the command line (sys.argv), and print the answer, input tokens, output tokens and the stop reason.'] },
          { tip: ['Type it, don\'t paste it. Today the point is your hands on the keyboard.'] },
        ],
        done: 'python hello.py "what is a token?" prints an answer and three numbers, and it is committed to git.',
      },
      {
        t: 'A chat that remembers (because you make it)',
        day: 'Day 2',
        goal: 'A terminal chat loop, and proof to yourself that the model is stateless.',
        steps: [
          { ul: [
            ['Write chat.py: a while loop that reads input(), sends it, and prints the reply.'],
            ['First version: send only the latest message. Tell it your name, then ask "what is my name?". Watch it fail.'],
            ['Second version: keep a messages list, append every user and assistant turn, and send the whole list. Ask again.'],
            ['Print the input token count after every turn and watch it climb.'],
            ['Add a limit: when history passes N turns, drop the oldest (keep the system prompt).'],
          ] },
        ],
        done: 'The second version remembers your name, the first does not, and you can explain why in one sentence.',
      },
      {
        t: 'Temperature experiment',
        day: 'Day 3',
        goal: 'See sampling with your own eyes instead of taking it on faith.',
        steps: [
          { ul: [
            ['Pick two prompts: one factual ("list the planets") and one creative ("name a coffee shop").'],
            ['Run each 5 times at temperature 0, then 5 times at 1.2. Save all outputs to a file.'],
            ['Count how many distinct answers you got in each setting.'],
            ['Write 3 to 5 lines in README.md: what changed, and which setting you would use for which job.'],
          ] },
        ],
        done: 'README.md has your results table and your own conclusion, in your own words.',
      },
      {
        t: 'Streaming and failure handling',
        day: 'Day 4',
        goal: 'Make the chat feel fast and survive things going wrong.',
        steps: [
          { ul: [
            ['Switch chat.py to streaming (stream=True) and print tokens as they arrive.'],
            ['Stop Ollama mid-chat (quit the app) and see what your code does. Then handle it: catch the error, print a clear message, and let the user retry.'],
            ['Add a timeout, and retry with a growing wait (1s, 2s, 4s) up to 3 times.'],
          ] },
          { tip: ['Production AI code is mostly this part. Interviewers love it when you mention it unprompted.'] },
        ],
        done: 'Killing Ollama mid-answer gives a clean message instead of a crash, and the chat recovers when it comes back.',
      },
      {
        t: 'Structured output + your first portfolio push',
        day: 'Day 5',
        goal: 'Make the model return data your code can trust, then publish the week.',
        steps: [
          { ul: [
            ['Write extract.py: give it a messy text (a receipt, an email, a job ad) and get back JSON with fixed fields, for example company, role, salary, location.'],
            ['Use Ollama\'s format option to request JSON, then parse it with json.loads and check every field exists and has the right type.'],
            ['If parsing or the check fails, send the error back to the model and retry once. Log when that happens.'],
            ['Create a public GitHub repo, push everything, and write a README: what each script does and what you learned.'],
          ] },
        ],
        done: 'A public repo with 4 working scripts and a README. Send me the link and I will review it like a hiring manager.',
      },
    ],
    quiz: [
      {
        q: 'A user says your chatbot "forgot" what they said 20 messages ago. What is the most likely cause?',
        o: ['The model has a short memory', 'Your code trimmed or did not resend that part of the history', 'The temperature was too high', 'The model was retrained'],
        a: 1,
        w: 'The model is stateless. It only sees what your code sends in the context window, so "forgetting" is almost always a history-management decision in the application.',
      },
      {
        q: 'You need to pull invoice numbers out of PDFs with the same output every run. Which temperature?',
        o: ['0 to 0.2', '0.7', '1.0', '1.5'],
        a: 0,
        w: 'Extraction wants the most likely token every time. Low temperature makes output focused and repeatable. You still validate, because 0 is not a guarantee.',
      },
      {
        q: 'Why do LLMs sometimes state wrong facts very confidently?',
        o: ['They are trained to lie', 'They predict plausible next tokens, not verified facts', 'The context window is too large', 'Streaming corrupts the answer'],
        a: 1,
        w: 'Fluency and truth are different things. The model produces what is likely given its training, which is why we ground answers in real sources and evaluate them.',
      },
      {
        q: 'A Thai message and an English message have the same number of characters. Which usually uses more tokens?',
        o: ['English', 'Thai', 'Always identical', 'Depends only on temperature'],
        a: 1,
        w: 'Tokenizers are usually trained mostly on English, so other scripts split into more, smaller tokens. That affects context limits and cost.',
      },
      {
        q: 'The response stop reason says it hit the length limit. What happened?',
        o: ['The model finished its answer', 'The answer was cut off at max output tokens', 'The prompt was rejected', 'A tool was called'],
        a: 1,
        w: 'The output was truncated. Raise the limit, ask for a shorter answer, or handle partial output in code. Always check the stop reason before trusting a response.',
      },
    ],
    drills: [
      {
        p: 'Walk me through exactly what happens, step by step, when your app sends a prompt to an LLM and streams back an answer.',
        m: [
          { ul: [
            ['The app builds the context: system prompt, history, any retrieved documents, the user message.'],
            ['Text is tokenized; the model runs over all input tokens.'],
            ['It outputs a probability distribution for the next token; sampling (temperature, top_p) picks one.'],
            ['The token is appended and the loop repeats; each token is streamed to the client as it is made.'],
            ['It stops at an end token or the max length; the response carries the stop reason and token usage.'],
            ['Bonus: mention you check the stop reason and log token usage for cost and debugging.'],
          ] },
        ],
      },
      {
        p: 'Our support bot gave a customer a refund policy that does not exist. Why did that happen, and how would you fix it?',
        m: [
          { ul: [
            ['Cause: the model generates plausible text; without the real policy in context it filled the gap from general patterns.'],
            ['Fix 1: ground it. Retrieve the actual policy (RAG) and instruct it to answer only from the provided sources, with citations.'],
            ['Fix 2: allow "I don\'t know" and hand off to a human when nothing relevant is retrieved.'],
            ['Fix 3: evals. A test set of policy questions with known answers, run on every change.'],
            ['Fix 4: for money-related answers, take facts from systems of record, not from generation.'],
          ] },
        ],
      },
      {
        p: 'Why would you run a model locally instead of calling a hosted API, and what would you give up?',
        m: [
          { ul: [
            ['For local: data never leaves the machine (privacy, compliance), no per-token cost, works offline, full control of the model version.'],
            ['Against: smaller models are weaker, especially at reasoning and tool use; you own the hardware, scaling and updates; slower on modest machines.'],
            ['A mature answer: choose per use case. Often local or private for sensitive data and high volume simple tasks, hosted frontier models for hard reasoning, with an abstraction layer so you can switch.'],
          ] },
        ],
      },
    ],
  },
];

export const BOOT_PLANNED: PlannedModule[] = [
  { id: 'retrieval', name: 'Embeddings and retrieval', week: 'Week 2', lede: 'Turn text into vectors, build semantic search from scratch, then compare it with keyword search.' },
  { id: 'rag', name: 'RAG from scratch', week: 'Weeks 2 to 3', lede: 'Chunking, retrieval, reranking and grounded answers with citations. No framework until you have built it by hand.' },
  { id: 'agents', name: 'Agents and tools', week: 'Weeks 3 to 4', lede: 'Write the tool-calling loop yourself, then add permissions, limits and recovery.' },
  { id: 'evals', name: 'Evals', week: 'Week 4', lede: 'Test sets, LLM-as-judge, regression runs. How you prove a change made things better.' },
  { id: 'guardrails', name: 'Guardrails and prompt injection', week: 'Week 5', lede: 'Attack your own app, then defend it.' },
  { id: 'production', name: 'Cost, latency and production', week: 'Weeks 5 to 6', lede: 'Caching, batching, model routing, observability, and one hosted API next to your local model.' },
  { id: 'capstone', name: 'Capstone and system-design mocks', week: 'Week 6 onward', lede: 'Build a small production-shaped RAG + agent app, then defend it in a full mock interview.' },
];
