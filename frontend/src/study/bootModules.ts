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
        t: 'Tokens: how text becomes numbers',
        b: [
          { p: [{ b: 'The problem. ' }, 'A neural network can only do maths on numbers. So before anything else, your text has to become a list of numbers. The question is: what should one number stand for?'] },
          { ul: [
            [{ b: 'One number per letter?' }, ' Only about 100 symbols, nice and small. But "elephant" becomes 8 steps, a page becomes thousands, and a single letter carries almost no meaning. Slow, and the model has to rebuild every word from scratch.'],
            [{ b: 'One number per word?' }, ' Short sequences, and each piece means something. But the list never ends: names, typos, "lolll", new slang, Thai, code. Anything not on the list is unreadable.'],
            [{ b: 'Word pieces.' }, ' The middle road everyone uses. Common words get one number; rare words are built from a few pieces. Nothing is ever unreadable, because the worst case falls back to single characters.'],
          ] },
          { p: [{ b: 'How the pieces are chosen (BPE). ' }, 'Start with single characters. Scan a huge pile of text, find the pair that sits side by side most often ("t" + "h"), and glue it into a new piece "th". Repeat: "th" + "e" becomes "the". Stop at roughly 100,000 pieces. That list is the model\'s fixed ', { term: 'vocabulary' }, ', and each piece is a ', { term: 'token' }, '.'] },
          { p: [{ b: 'So why "about 4 characters per token"? ' }, 'Nobody set that rule. It is just the average length a piece ends up with on ordinary English text after all that gluing. Text the tokenizer saw less of (Thai, Chinese, unusual code) gets glued less, so it splits into more, smaller pieces.'] },
          { p: [{ b: 'Token IDs. ' }, 'The vocabulary is a numbered list, and a ', { term: 'token ID' }, ' is just a piece\'s row number in it, like a page number in a dictionary. The number itself means nothing. The model uses it to look up a learned row of a few thousand numbers (the ', { term: 'embedding' }, '), and that row is where meaning lives. You will build with embeddings in Week 2.'] },
          { tip: [{ b: 'Try it (5 min). ' }, 'Open platform.openai.com/tokenizer and type, one at a time: hello, then " hello" with a space in front, then Hello, then unbelievable, then strawberry, then a Thai word. Watch the colours and the IDs. Then send the same sentence in English and in Thai to your own model and compare prompt_eval_count.'] },
          { p: [{ b: 'Check yourself. ' }, '(1) Why do "hello", " hello" and "Hello" get different IDs, and why would a tokenizer want that? (2) Why can a model write a great essay about strawberries but miscount the r\'s in the word? (3) Your Thai chatbot hits the context limit sooner than the English one. Why?'] },
        ],
        say: 'Text is split into subword tokens from a fixed vocabulary learned by merging frequent pairs; IDs are just indexes into an embedding table. So I budget context and cost in tokens, expect other languages to cost more, and expect weakness on character-level tasks.',
      },
      {
        t: 'Next-token prediction is the whole trick',
        b: [
          { p: [{ b: 'The puzzle. ' }, 'The model has exactly one skill: given some tokens, guess the next one. How does that produce essays, code and answers?'] },
          { p: [{ b: 'Training. ' }, 'Take trillions of tokens of text. Hide the next token, let the model guess, nudge its numbers to make the right answer a bit more likely, and repeat billions of times. To get really good at guessing the next word of a physics book, a court ruling or a Python file, it has to soak up grammar, facts, styles and patterns of reasoning. Those are side effects of one goal: guess the next token well.'] },
          { p: [{ b: 'Generation is a loop. ' }, 'The model reads all the tokens so far and outputs a probability for every token in its vocabulary (about 100,000 numbers). One token is picked, appended to the input, and the whole thing runs again. An answer of 300 tokens is 300 trips around that loop. That is why output streams word by word.'] },
          { p: [{ b: 'Why input is fast and output is slow. ' }, 'The prompt is read in one parallel pass, because all of it is known up front. Output needs a full pass per token, because each token depends on the one before. You measured this on your Mac mini: reading the prompt took about 0.2 seconds, and writing came out at about 30 tokens per second.'] },
          { p: [{ b: 'Why it states wrong things confidently. ' }, 'The training goal rewarded ', { b: 'likely-looking' }, ' text, not ', { b: 'true' }, ' text. When it does not know, nothing inside it says "stop". It keeps producing the most plausible continuation, which reads exactly as fluent as a correct one. That is a ', { term: 'hallucination' }, ', and it is the normal failure, not a rare glitch. Its knowledge also froze when training ended, so anything newer or private to you has to be put in the prompt. That is why RAG exists.'] },
          { tip: [{ b: 'Try it. ' }, 'Ask your model "What is the capital of France?", then "What is the capital of the country Zubrovia?" (it does not exist). Compare how confident the two answers sound. Then ask it to write a long story and watch the speed: steady, one token at a time.'] },
          { p: [{ b: 'Check yourself. ' }, '(1) Why does a 2,000-token answer take far longer than a 2,000-token prompt? (2) The model has never been told "lie". Where do hallucinations come from, then? (3) Why can the model not know yesterday\'s news, even though it "knows" a lot?'] },
        ],
        say: 'An LLM is trained only to predict the next token; knowledge and reasoning emerge from that. It generates in a loop, one token per pass, so it produces plausible text, not verified facts. Grounding and evals are how we make it trustworthy.',
      },
      {
        t: 'The context window, and why the model "forgets"',
        b: [
          { p: [{ b: 'The surprise. ' }, 'The model has no memory at all. Nothing is written anywhere while you chat. Its numbers (the ', { term: 'weights' }, ') were frozen when training ended. Each call is a pure function: tokens in, next-token probabilities out.'] },
          { p: [{ b: 'So how does a chat "remember"? ' }, 'Your code fakes it. Every turn, the app resends the whole conversation: system prompt, all previous messages, documents, tool results. The model reads it all fresh, every time. The ', { term: 'context window' }, ' is the maximum number of tokens that one call can hold, and that includes the answer it writes.'] },
          { p: [{ b: 'Why is there a limit at all? ' }, 'Inside the model, every token compares itself against every other token (that is ', { term: 'attention' }, '). Double the tokens and that work grows about four times. The model also has to keep notes on every token it has read (the KV cache), and that takes memory. Remember your 27b model sitting right at the edge of the Mac mini\'s graphics memory with a 32k context: a longer context needs more memory even though the model file is the same size.'] },
          { ul: [
            ['Long chats get slower and more expensive every turn, because everything is re-read.'],
            ['When history passes the limit, something has to be dropped or summarised. That is your design decision, not the model\'s.'],
            ['Models pay uneven attention over very long inputs. Facts buried in the middle get missed more often than facts at the start or end.'],
          ] },
          { tip: [{ b: 'Try it. ' }, 'In Open WebUI, tell the model your name, then open a NEW chat and ask "what is my name?". Same model, no memory, because the new chat sends no history. The Day 2 lab makes you build both versions yourself.'] },
          { p: [{ b: 'Check yourself. ' }, '(1) If the model is stateless, what is actually "remembering" in ChatGPT? (2) Why does turn 50 of a chat cost more than turn 1, even if both messages are short? (3) Your bot must remember a user\'s preferences forever. Where should that live, and how does it get back into the model?'] },
        ],
        say: 'The model is stateless with frozen weights; memory is something my application manages by choosing what goes back into the context window each turn, within a token budget that costs compute and memory.',
      },
      {
        t: 'Sampling: how one token gets picked',
        b: [
          { p: [{ b: 'The problem. ' }, 'The model hands you probabilities, not a word. Something has to choose. Say the text so far is "For lunch I want" and the model says: pizza 50%, rice 30%, sushi 15%, ... rocks 0.1%.'] },
          { ul: [
            [{ b: 'Always take the top one?' }, ' Predictable, but bland, and it can get stuck repeating itself, because the same input always gives the same top token.'],
            [{ b: 'Roll the dice by probability?' }, ' More natural and varied, but now and then you roll "rocks", and once a weird token is in, everything after builds on it.'],
          ] },
          { p: [{ term: 'Temperature' }, ' is the dial between those two. It reshapes the probabilities before the roll. Low temperature sharpens them: at 0.2, pizza goes from 50% to nearly 100%. High temperature flattens them: at 1.5, rice and sushi get much closer to pizza, and rocks becomes a real possibility.'] },
          { p: [{ term: 'top_p' }, ' and ', { term: 'top_k' }, ' cut the junk tail before rolling. top_k 40 keeps only the 40 likeliest tokens. top_p 0.9 keeps the smallest set that adds up to 90%. Both stop "rocks" from ever being picked. Change one knob at a time, or you will not know which one did what.'] },
          { ul: [
            ['Extraction, classification, code: low temperature. You want the most likely answer every time.'],
            ['Brainstorming, names, creative writing: higher. You want variety.'],
            ['Temperature 0 is close to repeatable, but not guaranteed. Ties between tokens and tiny floating-point differences on the GPU can still change a run. Never build a system that assumes identical output.'],
          ] },
          { tip: [{ b: 'Try it. ' }, 'In Terminal: ollama run qwen3.5:9b, then type /set parameter temperature 0 and ask "name a coffee shop" three times. Then /set parameter temperature 1.5 and ask three more times. The Day 3 lab turns this into a proper experiment.'] },
          { p: [{ b: 'Check yourself. ' }, '(1) Why does very high temperature eventually produce nonsense, not just "creative" text? (2) Why might you use low temperature AND top_p together? (3) Your extraction script gave a different answer on the second run at temperature 0. Is it broken?'] },
        ],
        say: 'Sampling turns probabilities into a token: temperature sharpens or flattens the distribution and top_p or top_k cut the tail. I set them by task, low for consistency and higher for variety, and never assume temperature 0 is deterministic.',
      },
      {
        t: 'Anatomy of a chat call',
        b: [
          { p: [{ b: 'The puzzle. ' }, 'The model only ever reads one long list of tokens. But every chat API takes a list of messages with roles: system, user, assistant. How do those fit together?'] },
          { p: [{ b: 'The chat template. ' }, 'Before your messages reach the model, they are flattened into one string with special marker tokens around each turn, something like "<|im_start|>system ... <|im_end|><|im_start|>user ... <|im_end|><|im_start|>assistant". The model was trained on thousands of conversations in exactly that format, so it learned what a "system" part usually means and that its job is to continue after "assistant". The roles are just text in labelled slots.'] },
          { p: ['That is why a system prompt is strong guidance, not a locked rule. It is in the same token stream as the user\'s text, so a clever user message can sometimes talk the model out of it. You will exploit and then defend this in the guardrails module.'] },
          { p: ['Every chat API, local or hosted, has the same shape:'] },
          { ul: [
            [{ b: 'messages' }, ': a list of turns, each with a role and content.'],
            [{ b: 'model' }, ' and ', { b: 'options' }, ': which model, temperature, maximum output length.'],
            [{ b: 'response' }, ': the text, the stop reason ("stop" means it finished; "length" means it was cut off at the limit), and token counts for input and output.'],
          ] },
          { code: 'import ollama\n\nresp = ollama.chat(\n    model="qwen3.5:9b",\n    messages=[\n        {"role": "system", "content": "Answer in one sentence."},\n        {"role": "user", "content": "Explain RAG."},\n    ],\n    options={"temperature": 0.2},\n)\nprint(resp["message"]["content"])\nprint("in:", resp["prompt_eval_count"], "out:", resp["eval_count"], "stop:", resp["done_reason"])' },
          { tip: [{ b: 'Try it. ' }, 'Run ollama show qwen3.5:9b --template to see the real chat template your model uses. Then run the code above with options={"num_predict": 5} and watch the stop reason turn into "length". If a reply is slow, the model is "thinking" first. Ask me how to switch that off.'] },
          { p: [{ b: 'Check yourself. ' }, '(1) If the system prompt is just text in the same stream, why does it work at all? (2) Why might you see a stop reason of "length" on a short question? (3) Anthropic, OpenAI and Ollama each have different libraries. What stays exactly the same across all three?'] },
        ],
        say: 'Under every framework it is the same call: role-tagged messages, flattened by a chat template into one token stream, in; text plus a stop reason and token usage out. The system prompt is strong guidance, not a security boundary.',
      },
      {
        t: 'What models are bad at, and why',
        b: [
          { p: ['Every weakness falls straight out of the lessons above. If you know the cause, you can guess the fix before anyone tells you.'] },
          { ul: [
            [{ b: 'Fresh or private facts.' }, ' Cause: the weights froze at training time, and your company\'s data was never in there. Fix: put the facts into the context (RAG).'],
            [{ b: 'Exact maths, counting, dates.' }, ' Cause: it sees tokens, not digits or letters, and it predicts likely text instead of computing. Fix: give it a tool (a calculator, code, an API) and let the tool do the exact part.'],
            [{ b: 'Consistent structure.' }, ' Cause: sampling is random by design, so the format can drift. Fix: ask for JSON, validate it in code, and retry on failure.'],
            [{ b: 'Taking actions.' }, ' Cause: it only produces text. It cannot press a button. Fix: your code reads its output and calls tools, with permission checks (agents, later).'],
            [{ b: 'Knowing when it is wrong.' }, ' Cause: plausible and true look identical from the inside. Fix: grounding, citations, and evals that check answers against known truth.'],
          ] },
          { p: ['Almost every AI-engineering pattern you will learn in the next six weeks is a fix for one of these.'] },
          { p: [{ b: 'Check yourself. ' }, 'For each weakness, name the earlier lesson that explains it. Then pick one app you use daily that has AI in it, and guess which of these fixes it is using.'] },
        ],
        say: 'Most AI engineering is compensating for weaknesses that follow from how models work: grounding for frozen or private knowledge, tools for exactness, validation for structure, guarded tools for actions, and evals for truth.',
      },
    ],
    labs: [
      {
        t: 'Your first model call',
        day: 'Day 1',
        goal: 'A real Python project on your laptop that calls a local model and prints the answer plus token counts.',
        steps: [
          { ul: [
            ['Install Ollama from ollama.com, then in Terminal: ', { b: 'ollama pull qwen3.5:9b' }, ' and try ', { b: 'ollama run qwen3.5:9b' }, ' once by hand.'],
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
      {
        q: 'Your app sends a 2,000-token prompt and gets a 2,000-token answer. Where does most of the waiting happen?',
        o: ['Reading the prompt', 'Writing the answer', 'Both take about the same time', 'Neither: it is all network time'],
        a: 1,
        w: 'The prompt is read in one parallel pass because all of it is known up front. The answer needs one full pass per token, since each token depends on the previous one. Output length drives latency.',
      },
      {
        q: 'A user types "ignore your instructions" and the bot does. Why was that even possible?',
        o: ['The system prompt was too short', 'The system prompt is text in the same token stream as the user message, not a separate locked channel', 'Temperature was too high', 'The context window was full'],
        a: 1,
        w: 'The chat template flattens system, user and assistant turns into one token sequence. The model learned to weight the system part heavily, but it is guidance, not enforcement. Real protection lives in your code: permissions, validation, and what tools the model can reach.',
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
