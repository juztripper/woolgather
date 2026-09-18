export type LearnCategory =
  "Getting started" | "Ideas" | "Projects" | "Your work";

export type Guide = {
  slug: string;
  cover: string;
  title: string;
  description: string;
  category: LearnCategory;
  minutes: number;
  icon:
    | "start"
    | "idea"
    | "project"
    | "plan"
    | "sources"
    | "agents"
    | "recovery"
    | "reasoning";
  sections: Array<{
    id: string;
    title: string;
    paragraphs: string[];
    bullets?: string[];
    steps?: string[];
    tip?: string;
  }>;
  related: string[];
};

export type Faq = {
  id: string;
  question: string;
  answer: string[];
  bullets?: string[];
  steps?: string[];
  guide: string;
};

export const categories: LearnCategory[] = [
  "Getting started",
  "Ideas",
  "Projects",
  "Your work",
];

export const guides: Guide[] = [
  {
    slug: "start-here",
    cover: "/art/learn/start-here-v1.webp",
    title: "Find your starting point",
    description: "Get to know Ideas and Projects, then choose where to begin.",
    category: "Getting started",
    minutes: 2,
    icon: "start",
    sections: [
      {
        id: "choose-a-space",
        title: "Start with what you have",
        paragraphs: [
          "woolgather helps you plan a software or game project. Bring a rough idea, a detailed description or a question you want to work through.",
          "There are two places to start. You can create a Project straight away; an Idea is optional.",
        ],
        bullets: [
          "**Idea:** a document for writing freely and collecting images or files.",
          "**Project:** a place to discuss your idea and build a plan, with or without AI help.",
        ],
        steps: [
          "Choose **New idea** or **New project** in your library.",
          "Write what you have in mind. A few sentences are enough.",
          "Return through your library whenever you like. **Pin to sidebar** keeps your work within easy reach.",
        ],
      },
      {
        id: "look-around-a-project",
        title: "Find your way around a project",
        paragraphs: [
          "A project opens on **Project space**. Send a message there to start a chat, or open one you have already saved. Opening a project does not create a chat or ask AI to reply.",
          "**Plan** keeps the notes you want to remember. These notes are called thoughts. A thought might be a decision, a possibility or a question. All chats in the project share the same Plan.",
        ],
        bullets: [
          "**Chats:** your conversations about the project.",
          "**Agents:** AI helpers you can give a particular job or focus.",
          "**Sources:** the files you have added for reference.",
        ],
        tip: "For a first message, try: “I’m planning a small gardening game. Help me think through what makes the first ten minutes enjoyable.”",
      },
      {
        id: "keep-what-matters",
        title: "Keep the useful parts",
        paragraphs: [
          "Talk through possibilities in a chat, then open **Plan** to see what has been saved. Review suggestions before choosing to keep them.",
          "To save your own words without an AI reply, open **Plan** and choose **Add a thought**.",
          "There is no required order or score to reach. Leave a question open and come back when you have something to add.",
        ],
      },
    ],
    related: ["develop-an-idea", "create-first-project", "shape-your-plan"],
  },
  {
    slug: "develop-an-idea",
    cover: "/art/learn/develop-an-idea-v1.webp",
    title: "Give an idea room to grow",
    description:
      "Write in your own words and keep useful images and files beside them.",
    category: "Ideas",
    minutes: 2,
    icon: "idea",
    sections: [
      {
        id: "write-freely",
        title: "Write what comes to mind",
        paragraphs: [
          "An Idea is your space to write freely. woolgather does not review it, score it or tell you what to write next. Opening, writing and saving an Idea do not use AI.",
          "Your document is made of blocks: small pieces such as paragraphs, headings, lists or images. You can also add checklists, quotes, tables, code and files.",
        ],
        steps: [
          "Choose **New idea** in your library. Give it a title when one comes to mind.",
          "Type **/** to choose a block. The **+** beside a block adds a new one before it.",
          "Select text to see its formatting options.",
          "Open the handle beside a block to change its type, or drag that handle to move it.",
        ],
      },
      {
        id: "collect-references",
        title: "Add images and files",
        paragraphs: [
          "Add a file through the editor, or paste or drag it into the document. You can give images captions and adjust their size or position. Uploaded files keep their original contents.",
          "Let uploads finish before leaving. If one fails, retry while the editor is open. After restarting the browser, you may need to select that file again, even if its empty space is still visible in the document.",
        ],
        tip: "Ideas save automatically. Look for **Saved**, or use **Retry save** if something went wrong.",
      },
      {
        id: "take-it-further",
        title: "Choose what happens next",
        paragraphs: [
          "Choose **Create project** when you want to take the idea into planning. Your complete document is kept with the project, and its files appear in **Sources**.",
          "You can still read the original Idea, but it stays locked for editing while its project is active or archived. To download your Idea without making a project, choose **Export**.",
        ],
        bullets: [
          "**Discuss the idea** uses your saved writing to start the first AI conversation.",
          "**Plan on my own** saves that writing as the project’s first thought, without AI help.",
        ],
      },
    ],
    related: [
      "create-first-project",
      "add-project-sources",
      "save-recover-and-export",
    ],
  },
  {
    slug: "create-first-project",
    cover: "/art/learn/create-first-project-v1.webp",
    title: "Start your first project",
    description:
      "Start from a blank page or bring an Idea you have already written.",
    category: "Getting started",
    minutes: 2,
    icon: "project",
    sections: [
      {
        id: "start-directly",
        title: "Start a new project",
        paragraphs: [
          "You do not need to write an Idea first. Creating a project from your library saves your starting point without asking AI to reply.",
        ],
        steps: [
          "Choose **New project** in your library.",
          "Add a name and a description, or leave them empty to start blank.",
          "Choose **Create project**. Any description you wrote is kept. A blank project opens **Project space**.",
          "Send a message to discuss the project, or open **Plan** and choose **Add a thought** to write on your own.",
        ],
      },
      {
        id: "start-from-an-idea",
        title: "Start from an Idea",
        paragraphs: [
          "If you already have an Idea, you can bring its saved document and files into a project. There is no need to copy your writing into another form.",
          "The **Planning** choice decides how your project begins:",
        ],
        bullets: [
          "**Discuss the idea** starts an AI conversation using your saved writing.",
          "**Plan on my own** saves the writing as a thought, without an AI reply.",
        ],
        steps: [
          "Open the Idea and choose **Create project**.",
          "Choose a name, location and planning option.",
          "If you chose AI help, check any credit limit shown for the first reply.",
          "Choose **Create project**. Continue from the opening already saved for you; you do not need to send the Idea again.",
        ],
        tip: "Opening the form does not start a reply. Choosing **Create project** with **Discuss the idea** selected does.",
      },
      {
        id: "continue-the-project",
        title: "Come back to your work",
        paragraphs: [
          "Choose the project name or **Back to project** to return to **Chats**, **Agents** and **Sources**. Each chat keeps its own draft. Opening a saved chat does not send a message.",
          "If project creation is interrupted, follow the message in the same form. When creating from an Idea, **Check creation** finds the original result so you can continue without making a second project.",
        ],
      },
    ],
    related: [
      "shape-your-plan",
      "work-with-chats-and-agents",
      "choose-reasoning",
    ],
  },
  {
    slug: "shape-your-plan",
    cover: "/art/learn/shape-your-plan-v1.webp",
    title: "Build a plan from your thoughts",
    description:
      "Save useful notes, decide which suggestions to keep and connect related ideas.",
    category: "Projects",
    minutes: 2,
    icon: "plan",
    sections: [
      {
        id: "capture-a-thought",
        title: "Save a thought",
        paragraphs: [
          "**Plan** keeps what matters about your project in one place. Each saved note is called a thought. It can hold a decision, a possibility, a question or a detail you want to remember.",
          "Open a thought to read it. This does not send anything to a chat.",
        ],
        steps: [
          "Open **Plan** and choose **Add a thought**.",
          "Write what you want to keep, in your own words.",
          "Choose **Add to plan**. Your words are saved without AI help.",
          "To change it later, open the thought, choose **Edit**, then **Save thought**. You can adjust the title, type and how certain you are about it.",
        ],
      },
      {
        id: "review-and-refine",
        title: "Choose which suggestions to keep",
        paragraphs: [
          "A chat can save the direction you describe and offer new suggestions. A suggestion stays separate until you choose **Keep this** or clearly say in the chat that you want to use it. You can also dismiss it.",
          "Open a thought to check its wording and, when available, the words it came from. Use **Edit** to change it or **Discuss** to add a link to it in your next message.",
          "A suggestion from AI or something written in a reference file is not automatically your decision. Check that the Plan says what you mean.",
        ],
        tip: "Try: “Keep the local co-op idea, but leave online multiplayer as an open question.” Then check the saved changes.",
      },
      {
        id: "connect-the-parts",
        title: "Connect related thoughts",
        paragraphs: [
          "Open a thought and choose **Connect** to show how it relates to another one. You can add a reason, such as why one part needs another.",
          "When you answer a question, save the answer with its thought and update its status. This makes it easier to understand later, without rereading the chat.",
        ],
        bullets: [
          "**Thoughts** lists your saved notes.",
          "**Connections** shows how thoughts relate and why.",
          "**Sequence** shows the order you have saved using **Followed by** connections. A thought’s place in the list does not create that order.",
        ],
      },
      {
        id: "correct-a-change",
        title: "Put something back",
        paragraphs: [
          "Use **Undo last plan update** when it is available to reverse the latest saved plan update. Later edits can make that undo unavailable, so check important changes soon after they happen.",
          "A removed thought can be restored from **Removed thoughts**. Deleting a chat is permanent, but thoughts already saved in Plan stay there.",
        ],
      },
    ],
    related: [
      "work-with-chats-and-agents",
      "add-project-sources",
      "save-recover-and-export",
    ],
  },
  {
    slug: "add-project-sources",
    cover: "/art/learn/add-project-sources-v1.webp",
    title: "Add useful files to your project",
    description:
      "Keep references together and explain what you want to use or avoid.",
    category: "Projects",
    minutes: 2,
    icon: "sources",
    sections: [
      {
        id: "add-a-source",
        title: "Keep your files in Sources",
        paragraphs: [
          "**Sources** holds the files added to your project. Every chat in that project can use them, so you do not need to upload a new copy for each conversation.",
          "Files brought over from an Idea also appear here.",
        ],
        steps: [
          "Choose **+** beside your message to upload a file or select one already saved.",
          "Open **Sources** in Project space to find and preview your files.",
          "Choose **Edit context** for a file to add a note about it.",
          "Choose how you want to use it, then select **Save context**.",
        ],
      },
      {
        id: "explain-the-reference",
        title: "Explain what the file is for",
        paragraphs: [
          "Tell woolgather which parts matter to you. A note might say: “Use the clear navigation, but avoid the crowded item cards.”",
          "Adding a file does not make everything in it part of your plan. Say what you want to keep in a message, or add it yourself as a thought.",
        ],
        bullets: [
          "**Use as a reference:** something you want to draw from.",
          "**Avoid:** something you do not want in this project.",
          "**Undecided:** something you are still considering.",
        ],
      },
      {
        id: "reference-in-chat",
        title: "Point to a file in a message",
        paragraphs: [
          "Type **@** or choose **+** to select a file, saved thought or active agent. An agent is an AI helper with a particular focus. Your selection appears as a clickable link inside the message.",
          "Removing that link from a draft removes it from the next message. It does not delete the saved file or thought.",
          "Open a file link to preview it, or download the original to keep a copy. AI cannot read every file type, even when the file can be stored. Check any notice shown before sending.",
        ],
        tip: "Deleting a source is permanent after you confirm. Download or export any copy you need first.",
      },
    ],
    related: [
      "develop-an-idea",
      "work-with-chats-and-agents",
      "save-recover-and-export",
    ],
  },
  {
    slug: "work-with-chats-and-agents",
    cover: "/art/learn/work-with-chats-and-agents-v1.webp",
    title: "Work with chats and agents",
    description:
      "Explore different questions and get help from an assistant with a focus you choose.",
    category: "Projects",
    minutes: 2,
    icon: "agents",
    sections: [
      {
        id: "separate-conversations",
        title: "Give each topic some space",
        paragraphs: [
          "You can use separate chats for different parts of a project, such as a welcome screen, a game rule or a choice of tools.",
          "Each chat has its own history and draft. They all share the project’s **Plan** and **Sources**, so your saved decisions and files stay together.",
        ],
        steps: [
          "Return to **Project space** to prepare a new chat. To continue an older one, select it under **Chats**.",
          "Describe what you want to work through. Use **+** or **@** to include a saved thought or file.",
          "Type **/** to choose an action such as **Compare approaches** or **Challenge assumptions**, if it helps. Choosing an action does not send the message.",
          "Send when you are ready. After the reply, check any changes saved in **Plan**.",
        ],
      },
      {
        id: "give-an-agent-a-focus",
        title: "Create an agent for a particular job",
        paragraphs: [
          "An agent is an AI helper you give a particular focus. For example, one could help make your app easier to use, while another helps explore game ideas.",
          "Open **Agents** and create one with a name, picture and instructions. Say what you want help with. Creating or editing an agent does not ask it to reply.",
          "Select an agent to open a chat, or mention it in a message. A group conversation can include two agents. They may reply or listen, depending on the discussion.",
          "Their advice stays a suggestion until you decide to keep it.",
        ],
        tip: "An instruction could be: “Help me make the app easy to read and use with a keyboard. Point out anything that depends on color alone.”",
      },
      {
        id: "branch-a-conversation",
        title: "Try another direction",
        paragraphs: [
          "Choose **Branch** on a message to start a new chat from that point. The new chat can use the conversation up to that message, but starts without the messages that came after it.",
          "Both chats still share the same **Plan**. A branch gives you another conversation, not a separate copy of the project. Its link takes you back to the original chat.",
        ],
        tip: "You can rename chats. Deleting a chat is permanent, so export any conversation you want to keep first.",
      },
    ],
    related: ["shape-your-plan", "add-project-sources", "choose-reasoning"],
  },
  {
    slug: "save-recover-and-export",
    cover: "/art/learn/save-recover-and-export-v1.webp",
    title: "Save, recover and download your work",
    description:
      "Know what is saved, pick up after an interruption and keep a copy.",
    category: "Your work",
    minutes: 3,
    icon: "recovery",
    sections: [
      {
        id: "check-the-save-state",
        title: "Check that your work is saved",
        paragraphs: [
          "Ideas save automatically. For a new thought, choose **Add to plan**. After editing an existing thought, choose **Save thought**.",
          "**Saved** means your latest changes have been saved to your account. **Draft kept on this device** means there is a copy in this browser to help you recover. That draft may not be available on another device.",
          "If saving fails, keep your draft and use the retry action shown. If the saved version changed somewhere else, compare the versions before choosing what to keep.",
        ],
      },
      {
        id: "recover-an-interruption",
        title: "Pick up after an interruption",
        paragraphs: [
          "If a reply stops partway through, the words you can see may not be saved yet. Reopening the project shows its saved progress; it does not ask AI to start again.",
        ],
        steps: [
          "Return to the same Idea, project or chat and read the message shown.",
          "If woolgather is still checking whether something finished, use the check action offered.",
          "Choose **Retry** when it is available and you want to try failed work again. Retrying a reply uses the message you already sent.",
          "If a file upload failed, use its retry action. A project may keep the file ready to retry on the same device. In an Idea, you may need to select the file again after restarting your browser.",
        ],
        tip: "Keep your original files until uploads finish. Clearing browser data can remove local drafts and unfinished uploads, so download a copy of important work too.",
      },
      {
        id: "download-your-work",
        title: "Download a copy",
        paragraphs: [
          "Choose **Export** in an Idea, or **Export project** in a project’s actions. Export means downloading a copy of your work.",
          "An Idea downloads as a ZIP: one package you can open to find your document and original files inside. A Project downloads as a Markdown document, or as a ZIP when it includes an Idea document or attached files.",
          "If a required file cannot be downloaded, woolgather shows an error instead of quietly leaving it out.",
        ],
        bullets: [
          "**Markdown** is a text document you can read in many writing apps.",
          "**JSON** is the file in a ZIP that keeps the full saved structure and formatting details. Keep it alongside the readable copy.",
        ],
      },
      {
        id: "understand-removal",
        title: "Know what you can restore",
        paragraphs: ["Different removal actions have different effects:"],
        bullets: [
          "**Archive** keeps a project available to read.",
          "**Trash** lets you restore a project later. It also unlocks the linked Idea for editing. Restoring the project keeps its original copy of the Idea and does not lock the Idea again.",
          "**Removed thoughts** lets you restore a thought you removed from Plan.",
          "**Deleting a chat or source** is permanent after confirmation, with no Undo or Restore. Deleting a chat leaves thoughts already saved in Plan.",
        ],
      },
    ],
    related: ["develop-an-idea", "shape-your-plan", "choose-reasoning"],
  },
  {
    slug: "choose-reasoning",
    cover: "/art/learn/choose-reasoning-v1.webp",
    title: "Choose how much AI help to use",
    description:
      "Pick an effort level, check your credits and keep working on your own when you need to.",
    category: "Your work",
    minutes: 2,
    icon: "reasoning",
    sections: [
      {
        id: "choose-effort",
        title: "Choose an effort level",
        paragraphs: [
          "The effort level controls how much work AI puts into a reply. Open the menu beside the send button to choose a level.",
          "You can leave it on **Auto** if you would rather woolgather choose for each message. Changing the level does not send your message.",
        ],
        bullets: [
          "**Auto** chooses Quick, Thoughtful or Deep to suit your message and chosen action.",
          "**Quick** suits a straightforward question or exchange.",
          "**Thoughtful** gives more room to explore an idea.",
          "**Deep** suits a more involved comparison or challenge.",
        ],
        tip: "The menu also shows the model—the AI used for the reply. Check any credit limit before sending. More effort does not guarantee a correct answer.",
      },
      {
        id: "understand-usage",
        title: "Check your credits and limits",
        paragraphs: [
          "Credits cover AI replies. Before you send, the displayed maximum tells you how many credits that reply can use. That amount is set aside while the work runs; any unused credits return once the result is confirmed.",
          "If a reply’s result is still being checked, some credits may stay on hold until that check finishes.",
          "Open your account menu and choose **Settings** to see what is available to your account. When usage information is available, these sections show the details:",
        ],
        bullets: [
          "**Billing** shows your plan and available plan options.",
          "**Usage** shows your credits, voice time, file storage and amounts on hold.",
        ],
      },
      {
        id: "continue-manually",
        title: "Keep working without an AI reply",
        paragraphs: [
          "Reading and writing on your own do not ask AI to reply. If you run out of credits, you can still write Ideas, read saved work, add your own thoughts and export.",
          "Sending a chat message or creating a project with **Discuss the idea** selected starts AI help. Choose **Plan on my own** when creating from an Idea to start without it.",
          "If you prefer speaking to typing, the voice controls do different things:",
        ],
        bullets: [
          "**Microphone:** turns your speech into a draft. You can edit the words and choose when to send. This depends on your browser’s support.",
          "**Waveform:** the sound-wave button starts a live spoken conversation where voice is available. It depends on your account’s access and remaining voice time.",
        ],
      },
    ],
    related: [
      "create-first-project",
      "shape-your-plan",
      "save-recover-and-export",
    ],
  },
];

export const faqs: Faq[] = [
  {
    id: "idea-or-project",
    question: "What is the difference between an Idea and a Project?",
    answer: [
      "An Idea gives you space to write. A Project gives you space to discuss and plan.",
      "You can start with either one. You do not need an Idea before creating a Project.",
    ],
    bullets: [
      "**Idea:** write freely and collect images or files in one document.",
      "**Project:** keep chats, saved thoughts, AI helpers and reference files together.",
    ],
    guide: "start-here",
  },
  {
    id: "idea-assistance",
    question: "Does woolgather review or rewrite my Ideas?",
    answer: [
      "No. You control the writing. Ideas have no AI review, score or prompts telling you what to write.",
      "AI help starts when you send a project message or create a project with **Discuss the idea** selected.",
    ],
    guide: "develop-an-idea",
  },
  {
    id: "skip-the-idea",
    question: "Can I create a Project without an Idea first?",
    answer: [
      "Yes. Choose **New project** in your library. Add a name and description if you like, then choose **Create project**.",
      "This saves your starting point without asking AI to reply. Afterward, send a message or open **Plan** and choose **Add a thought** to work on your own.",
    ],
    guide: "create-first-project",
  },
  {
    id: "opening-usage",
    question: "Does opening my work use credits?",
    answer: [
      "No. Opening an Idea, project or chat does not use AI. Reading, formatting, writing on your own and exporting do not request a reply either.",
      "AI help starts when you send a project message or choose **Create project** with **Discuss the idea** selected.",
    ],
    guide: "choose-reasoning",
  },
  {
    id: "original-idea",
    question: "What happens to my Idea when I create a Project from it?",
    answer: [
      "The project keeps a complete copy of your document, and its files appear in **Sources**. You can still read the original Idea.",
    ],
    bullets: [
      "While the linked project is active or archived, the original Idea is locked for editing.",
      "Moving the project to **Trash** unlocks the Idea.",
      "Restoring the project keeps its original copy and does not lock the Idea again.",
    ],
    guide: "create-first-project",
  },
  {
    id: "suggestions-and-decisions",
    question: "Does every suggestion become part of my Plan?",
    answer: [
      "No. A suggestion stays separate until you choose **Keep this** or clearly say in the chat that you want to use it. You can dismiss a suggestion too.",
      "Open a saved thought to check its wording and, when available, the words it came from. Choose **Edit** if it needs changing.",
    ],
    guide: "shape-your-plan",
  },
  {
    id: "shared-context",
    question: "Do separate chats share the same project?",
    answer: [
      "Yes. Each chat has its own messages and draft, but all chats in a project share the same **Plan** and **Sources**.",
      "A branched chat also shares the Plan. It gives you another conversation from a chosen message, not a separate copy of the project.",
    ],
    guide: "work-with-chats-and-agents",
  },
  {
    id: "source-meaning",
    question: "How do I explain what a reference is for?",
    answer: [
      "Add a note to the file in **Sources**. Explain what you like about it, what to avoid or what you are still deciding.",
    ],
    steps: [
      "Open **Sources** and choose **Edit context** for the file.",
      "Write your note and choose **Use as a reference**, **Avoid** or **Undecided**.",
      "Choose **Save context**. You can then include the file in a message with **+** or **@**.",
    ],
    guide: "add-project-sources",
  },
  {
    id: "connection-lost",
    question: "What should I do if saving or a reply is interrupted?",
    answer: [
      "Return to the same work and read the message shown. Use the offered check action while woolgather is finding out what happened, or **Retry** when it is available.",
      "Reopening does not ask AI for another reply. A draft kept on this device is a copy in this browser; look for **Saved** before relying on it from another device.",
    ],
    guide: "save-recover-and-export",
  },
  {
    id: "export-work",
    question: "Can I download my work and original files?",
    answer: [
      "Yes. Choose **Export** in an Idea or **Export project** in a project’s actions.",
      "An Idea downloads as a ZIP package with your document and original files inside. A Project downloads as Markdown, a text document many writing apps can open, or as a ZIP when it includes an Idea document or attached files.",
      "If a required file cannot be downloaded, woolgather shows an error instead of leaving it out.",
    ],
    guide: "save-recover-and-export",
  },
  {
    id: "no-credits",
    question: "Can I keep working when I run out of credits?",
    answer: [
      "Yes. Your saved work, writing tools, recovery options and exports remain available.",
      "Use **Add a thought** in Plan, or choose **Plan on my own** when creating from an Idea. Open **Settings**, then **Usage**, to check what is available to your account.",
    ],
    guide: "choose-reasoning",
  },
  {
    id: "dictation-and-voice",
    question: "What is the difference between dictation and live voice?",
    answer: [
      "Dictation writes down what you say. Live voice lets you have a spoken conversation.",
    ],
    bullets: [
      "**Microphone:** puts your words into a draft. Edit them and send when you are ready. Browser support varies.",
      "**Waveform:** the sound-wave button starts a live conversation where available. Your account needs voice access and time remaining.",
    ],
    guide: "choose-reasoning",
  },
];
