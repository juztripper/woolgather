import { useState } from "react";
import { Button } from "../ui/Button";
import neutral from "./assets/character-b-neutral.svg";
import blink from "./assets/character-b-blink.svg";
import greeting from "./assets/character-b-greeting.svg";
import "./mascot-art.css";

export function MascotArtPreview() {
  const [sky, setSky] = useState(true);
  return (
    <div
      className={`entry-page mascot-art-page${sky ? "" : " mascot-art-paper"}`}
    >
      <header className="entry-header">
        <span className="brand" role="img" aria-label="woolgather">
          <img
            className="brand-symbol"
            src="/brand/gather-symbol.svg"
            alt=""
            width="38"
            height="38"
          />
          <span className="brand-wordmark" aria-hidden="true">
            woolgather
          </span>
        </span>
        <Button
          variant="quiet"
          aria-pressed={!sky}
          onClick={() => setSky((v) => !v)}
        >
          {sky ? "View on ivory" : "View on sky"}
        </Button>
      </header>
      <main className="mascot-art-board">
        <h1>Character B, refined.</h1>
        <p className="mascot-art-subtitle">
          One vector master. A consistent face.
        </p>
        <div className="mascot-art-expressions">
          <figure className="mascot-art-hero">
            <img
              src={neutral}
              alt="Neutral character B with an ivory curled silhouette, level eyes and centered smile"
            />
            <figcaption>Neutral master</figcaption>
          </figure>
          <div className="mascot-art-variants">
            <figure>
              <img
                src={blink}
                alt="Blink: eyelids close gently at their original eye centers"
              />
              <figcaption>Blink</figcaption>
            </figure>
            <figure>
              <img
                src={greeting}
                alt="Greeting: raised happy-eye curves with the same anchors"
              />
              <figcaption>Greeting</figcaption>
            </figure>
          </div>
        </div>
        <section
          className="mascot-art-sizes"
          aria-label="Actual rendered sizes"
        >
          {[64, 96, 128].map((size) => (
            <figure key={size}>
              <img
                src={neutral}
                width={size}
                height={size}
                alt={`Neutral mascot in a ${size} pixel square`}
              />
              <figcaption>{size}px</figcaption>
            </figure>
          ))}
        </section>
      </main>
      <footer className="mascot-art-footer">
        Artwork review · SVG master, before Rive rigging
      </footer>
    </div>
  );
}
