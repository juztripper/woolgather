import { Brand } from "./Brand";
import { ActionMenu } from "../library/ProjectMenu";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ModalPresence } from "@/ui/Modal";
import { Checkbox } from "./Checkbox";
import { useToast } from "./Toast";
import { RefreshButton } from "./RefreshButton";
import { Select } from "./Select";
import { Disclosure } from "./Disclosure";
import { Avatar, avatars } from "../account/Avatar";
import { Badge } from "./Badge";
import { useState } from "react";
import { Plus, Check, ArrowLeft, X } from "lucide-react";
import { Button, IconButton, ProviderButton } from "./Button";
import { Modal } from "./Modal";
import "./design-system.css";

/** Development-only reference. Exercises the actual shared components, with no API calls. */
export function DesignSystem() {
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const [formValue, setFormValue] = useState("");
  return (
    <main className="design-system">
      <header>
        <Brand />
        <h1>Component reference</h1>
        <p>
          shadcn/ui · Base UI · Nova. The actual components used throughout
          woolgather, with their standard appearance and transitions.
        </p>
      </header>
      <section className="system-panel">
        <h2>Actions and views</h2>
        <p>
          Dropdown Menu groups actions. Select chooses a value. Tabs switch
          between peer views.
        </p>
        <div className="system-actions">
          <ActionMenu
            active={false}
            trashed={false}
            label="Example actions"
            trigger={<Button>Example actions</Button>}
            options={[
              ["rename", "Edit example"],
              ["delete", "Delete example"],
            ]}
            onAction={(action) =>
              action === "delete" ? setConfirmation(true) : setOpen(true)
            }
          />
          <Select
            label="Example status"
            defaultValue="draft"
            options={[
              { value: "draft", label: "Draft" },
              { value: "ready", label: "Ready" },
              { value: "unavailable", label: "Unavailable", disabled: true },
            ]}
          />
          <Select
            label="Example collection"
            options={Array.from({ length: 24 }, (_, index) => ({
              value: String(index + 1),
              label: `Reference collection ${String(index + 1).padStart(2, "0")}`,
            }))}
          />
        </div>
        <Tabs defaultValue="conversation" className="mt-6">
          <TabsList aria-label="Example views">
            <TabsTrigger value="conversation">Conversation</TabsTrigger>
            <TabsTrigger value="plan">Plan</TabsTrigger>
          </TabsList>
          <TabsContent value="conversation">
            <p className="mt-4">
              Talk through your project. Open the plan when you need it.
            </p>
          </TabsContent>
          <TabsContent value="plan">
            <p className="mt-4">
              Your plan stays connected to the conversation.
            </p>
          </TabsContent>
        </Tabs>
      </section>
      <section className="system-panel">
        <h2>Profile pictures</h2>
        <div className="system-actions">
          {avatars.map((art) => (
            <figure key={art.id}>
              <Avatar
                user={{ id: "preview", user_metadata: {} }}
                value={art.id}
                large
              />
              <figcaption>{art.name}</figcaption>
            </figure>
          ))}
        </div>
        <Disclosure title="About the collection">
          <p>
            Eight original vector presets. A profile stores the chosen ID, with
            no uploads or remote avatar service.
          </p>
        </Disclosure>
        <Disclosure title="Using a profile picture" variant="plain">
          <p>Choose a picture in Settings → Personalization.</p>
        </Disclosure>
      </section>
      <section className="system-panel">
        <h2>Checkboxes</h2>
        <div className="system-checkboxes">
          <label>
            <Checkbox defaultChecked />
            Show ideas
          </label>
          <label>
            <Checkbox />
            Show archive
          </label>
          <label>
            <Checkbox defaultChecked disabled />
            Saving selection
          </label>
          <label>
            <Checkbox disabled />
            Unavailable option
          </label>
        </div>
      </section>
      <section className="system-panel">
        <h2>Badges</h2>
        <div className="system-actions">
          <Badge>Draft</Badge>
          <Badge tone="accent">Last used</Badge>
          <div className="signin-method">
            <ProviderButton
              provider="github"
              aria-describedby="badge-example"
            />
            <Badge
              tone="accent"
              className="signin-method-badge"
              id="badge-example"
            >
              Last used
            </Badge>
          </div>
        </div>
      </section>
      <section className="system-panel">
        <h2>Actions</h2>
        <Button onClick={() => notify("Saved")}>Preview notification</Button>
        <Button
          onClick={() =>
            notify("Check your email to finish this change.", { tone: "info" })
          }
        >
          Preview information
        </Button>
        <Button
          onClick={() =>
            notify("That change could not be saved. Please try again.", {
              tone: "error",
            })
          }
        >
          Preview error
        </Button>
        <RefreshButton
          label="Preview refresh"
          onRefresh={() => new Promise((resolve) => setTimeout(resolve, 1600))}
        />
        <div className="system-actions">
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus />
            New project
          </Button>
          <Button onClick={() => setOpen(true)}>Open editor</Button>
          <Button variant="quiet">
            <ArrowLeft />
            Back
          </Button>
          <Button variant="danger">Move to removed</Button>
          <Button variant="danger-primary">Delete account</Button>
          <IconButton aria-label="Close example">
            <X />
          </IconButton>
        </div>
        <div className="system-actions">
          <Button variant="primary" disabled>
            Saving…
          </Button>
          <Button disabled>Cancel</Button>
          <Button variant="primary" aria-busy="true">
            Saving…
          </Button>
        </div>
      </section>
      <section className="system-panel">
        <h2>Account providers</h2>
        <div className="system-providers">
          <ProviderButton provider="google" />
          <ProviderButton provider="github" />
        </div>
      </section>
      <section className="system-panel">
        <h2>Form controls</h2>
        <label>
          Project name
          <Input placeholder="Untitled Project" />
        </label>
        <label>
          Your idea
          <Textarea placeholder="A little room to think…" />
        </label>
        <label>
          Certainty
          <Select
            label="Certainty"
            defaultValue="tentative"
            options={[
              { value: "tentative", label: "Tentative" },
              { value: "confirmed", label: "Confirmed" },
            ]}
          />
        </label>
      </section>
      <section className="system-panel">
        <h2>Typography</h2>
        <h3>A clear, familiar interface.</h3>
        <p>
          Geist is used for the interface: 14px text, regular navigation and
          medium headings. Source Serif 4 is reserved for reading. Controls
          share 28, 34, 40 and 44px size roles, padding and typography tokens.
        </p>
        <span className="eyebrow">SUPPORTING LABEL</span>
      </section>
      {saved && (
        <p role="status">
          Example saved. Certainty: {formValue}. No project data was changed.
        </p>
      )}
      <ModalPresence>
        {open && (
          <Modal
            title="A shared editor"
            onClose={() => setOpen(false)}
            footer={
              <>
                <Button onClick={() => setOpen(false)}>Cancel</Button>
                <Button
                  variant="primary"
                  type="submit"
                  form="component-example"
                >
                  <Check />
                  Save changes
                </Button>
              </>
            }
          >
            <form
              id="component-example"
              onSubmit={(e) => {
                e.preventDefault();
                setFormValue(
                  String(new FormData(e.currentTarget).get("certainty")),
                );
                setSaved(true);
                setOpen(false);
              }}
            >
              <label>
                Title
                <Input defaultValue="A thought worth keeping" required />
              </label>
              <label>
                Notes
                <Textarea defaultValue="The same button, typography, focus and spacing rules apply here." />
              </label>
              <label>
                Certainty
                <Select
                  label="Editor certainty"
                  name="certainty"
                  defaultValue="tentative"
                  options={[
                    { value: "tentative", label: "Tentative" },
                    { value: "confirmed", label: "Confirmed" },
                  ]}
                />
              </label>
            </form>
          </Modal>
        )}
      </ModalPresence>
      <ModalPresence>
        {confirmation && (
          <Modal
            confirmation
            title="Delete this example?"
            onClose={() => setConfirmation(false)}
            footer={
              <>
                <Button onClick={() => setConfirmation(false)}>Cancel</Button>
                <Button
                  variant="danger-primary"
                  onClick={() => {
                    setConfirmation(false);
                    notify("Example deleted", {
                      action: {
                        label: "Undo",
                        onClick: () => notify("Example restored"),
                      },
                    });
                  }}
                >
                  Delete example
                </Button>
              </>
            }
          >
            <p>
              This preview only exercises the confirmation. It does not delete
              project data.
            </p>
          </Modal>
        )}
      </ModalPresence>
    </main>
  );
}
