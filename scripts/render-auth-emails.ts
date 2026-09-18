import { writeFile } from "node:fs/promises";
import { authEmailTemplates, brandedEmail } from "../packages/emails/src/index";
for (const [name, message] of Object.entries(authEmailTemplates))
  await writeFile(`apps/web/emails/${name}.html`, brandedEmail(message) + "\n");
