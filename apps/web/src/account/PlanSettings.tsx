import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import { Button } from "../ui/Button";
import { api } from "../client";
import { usePlan } from "./PlanProvider";
import {
  planOffer,
  type PlanSnapshot,
} from "../../../../packages/domain/src/plans";
import "./billing.css";

export type PlanSettingsSection = "billing" | "usage";
const number = (value: number) => value.toLocaleString();
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;
const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
const storage = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${Number((bytes / 1024 ** 3).toFixed(1))} GB`
    : `${Number((bytes / 1024 ** 2).toFixed(1))} MB`;
const price = `€${planOffer.paid.priceMinor / 100}`;

function Meter({
  title,
  amount,
  total,
  description,
  used = false,
  format = number,
}: {
  title: string;
  amount: number;
  total: number;
  description: string;
  used?: boolean;
  format?: (value: number) => string;
}) {
  return (
    <section className="usage-meter" aria-label={title}>
      <div className="usage-meter-heading">
        <h3>{title}</h3>
        <span>
          {format(amount)}{" "}
          <span className="billing-muted">
            of {format(total)} {used ? "used" : "left"}
          </span>
        </span>
      </div>
      <p>{description}</p>
      <div
        className="usage-track"
        role="progressbar"
        aria-label={`${title} ${used ? "used" : "remaining"}`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(total, amount)}
        aria-valuetext={`${format(amount)} of ${format(total)} ${used ? "used" : "remaining"}`}
      >
        <span
          style={{
            width: `${Math.min(100, Math.max(0, (amount / total) * 100))}%`,
          }}
        />
      </div>
    </section>
  );
}

function Usage({ plan }: { plan: PlanSnapshot }) {
  if (!plan.enabled)
    return (
      <div className="billing-empty">
        <h3>{plan.testing ? "Testing access" : "Usage isn’t active yet"}</h3>
        <p>
          {plan.testing
            ? "Your testing access uses development funding. Subscription balances aren’t measured for this account."
            : "Your allowances will appear here when plans are available."}
        </p>
      </div>
    );
  const paid = plan.tier === "paid";
  const period = date(plan.renewsAt);
  return (
    <div className="usage-page">
      <section className="usage-section">
        <div className="billing-section-heading">
          <h3>Plan limits</h3>
          <span>{number(plan.credits)} credits available</span>
        </div>
        <p className="billing-muted">
          Used for project replies. Manual writing, saved work and export remain
          available when credits run out.
        </p>
        <Meter
          title="Monthly credits"
          amount={plan.monthlyCredits}
          total={
            paid ? planOffer.paid.monthlyCredits : planOffer.free.monthlyCredits
          }
          description={
            period
              ? `Current period ends ${period}. Unused credits do not roll over.`
              : "Unused monthly credits do not roll over."
          }
        />
        <Meter
          title="Welcome credits"
          amount={plan.welcomeCredits}
          total={planOffer.free.welcomeCredits}
          description="A one-time allowance that never expires."
        />
        {plan.reservedCredits > 0 && (
          <p role="status" className="billing-muted">
            {number(plan.reservedCredits)} credits reserved for replies in
            progress, separate from your available balance.
          </p>
        )}
      </section>
      {paid && (
        <section className="usage-section">
          <h3>Live voice</h3>
          <Meter
            title="Monthly voice allowance"
            amount={plan.voiceSeconds}
            total={planOffer.paid.voiceSeconds}
            format={duration}
            description={
              plan.reservedVoiceSeconds > 0
                ? `${duration(plan.reservedVoiceSeconds)} reserved for a call. Unused time expires at the paid period end.`
                : "Connected time counts toward your allowance. Unused time does not roll over."
            }
          />
        </section>
      )}
      <section className="usage-section">
        <h3>Storage</h3>
        <Meter
          title="Attachments"
          amount={plan.storageBytes}
          total={plan.storageLimitBytes}
          format={storage}
          used
          description="Your saved files remain available if you change plans."
        />
      </section>
      <p className="billing-footnote">
        You see each reply’s maximum before sending. Failed replies are not
        charged, and there are no automatic overages.
      </p>
    </div>
  );
}

function Comparison({
  plan,
  busy,
  onCheckout,
}: {
  plan: PlanSnapshot;
  busy: boolean;
  onCheckout: (action: "checkout" | "portal") => void;
}) {
  const paid = plan.tier === "paid" && !plan.testing;
  const free = plan.tier === "free" && !plan.testing;
  const disabled = busy || plan.checkout === "unavailable" || plan.testing;
  return (
    <div className="plan-picker-content">
      <div className="plan-cards">
        <article className="plan-card">
          <h3>Free</h3>
          <p className="plan-card-description">Space to explore your ideas</p>
          <p className="plan-card-price">
            <span>€0</span>
            <span>/ month</span>
          </p>
          <Button
            fullWidth
            disabled={free || disabled}
            onClick={() => onCheckout("portal")}
          >
            {free ? "Your current plan" : "Manage subscription"}
          </Button>
          <ul className="plan-features">
            <li>
              <Check />
              <span>Luna at every reasoning level</span>
            </li>
            <li>
              <Check />
              <span>100 credits each month</span>
            </li>
            <li>
              <Check />
              <span>200 welcome credits, yours to keep</span>
            </li>
            <li>
              <Check />
              <span>100 MB of attachment storage</span>
            </li>
            <li>
              <Check />
              <span>Ideas, projects and export</span>
            </li>
          </ul>
        </article>
        <article className="plan-card">
          <h3>{planOffer.paid.name}</h3>
          <p className="plan-card-description">
            More room to develop your work
          </p>
          <p className="plan-card-price">
            <span>{price}</span>
            <span>
              / month <small>Tax included</small>
            </span>
          </p>
          <Button
            fullWidth
            variant="primary"
            disabled={paid || disabled}
            onClick={() => onCheckout("checkout")}
          >
            {paid
              ? "Your current plan"
              : busy
                ? "Opening checkout…"
                : "Subscribe"}
          </Button>
          <p className="plan-includes">Everything in Free, plus:</p>
          <ul className="plan-features">
            <li>
              <Check />
              <span>Luna and Sol, with your choice of effort</span>
            </li>
            <li>
              <Check />
              <span>1,500 credits each month</span>
            </li>
            <li>
              <Check />
              <span>20 minutes of live voice each month</span>
            </li>
            <li>
              <Check />
              <span>1 GB of attachment storage</span>
            </li>
          </ul>
        </article>
      </div>
      <div className="plan-picker-notes">
        {plan.checkout === "unavailable" && (
          <p>Subscriptions are not open yet.</p>
        )}
        {plan.testing && (
          <p>
            Your account has testing access. No subscription is required for
            testing.
          </p>
        )}
        {plan.checkout === "test" && (
          <p>
            Test checkout does not take a real payment or grant live credits.
          </p>
        )}
        <p>
          Monthly credits and voice minutes don’t roll over. Welcome credits
          never expire. No automatic overages.
        </p>
      </div>
    </div>
  );
}

function Billing({
  plan,
  busy,
  onCompare,
  onPortal,
}: {
  plan: PlanSnapshot;
  busy: boolean;
  onCompare: () => void;
  onPortal: () => void;
}) {
  const paid = plan.tier === "paid" && !plan.testing;
  const portalUnavailable =
    busy || plan.checkout === "unavailable" || plan.testing;
  return (
    <div className="billing-page">
      <section className="billing-current billing-row">
        <div>
          <h3>
            {plan.testing
              ? "Testing access"
              : `woolgather ${paid ? planOffer.paid.name : planOffer.free.name}`}
          </h3>
          <p>
            {plan.testing
              ? "This account has development access."
              : paid
                ? `${price} per month, tax included${plan.paidUntil ? `. Current period ends ${date(plan.paidUntil)}.` : "."}`
                : "No subscription. Luna at every reasoning level."}
          </p>
        </div>
        <Button data-compare-plans onClick={onCompare}>
          {paid ? "Change plan" : "Upgrade plan"}
        </Button>
      </section>
      <section className="billing-group">
        <div className="billing-section-heading">
          <h3>Transaction history</h3>
          <Button disabled={portalUnavailable} onClick={onPortal}>
            View invoices <ExternalLink aria-hidden="true" />
          </Button>
        </div>
        <p className="billing-muted">
          View and download your invoices in Stripe.
        </p>
      </section>
      <section className="billing-group">
        <div className="billing-section-heading">
          <h3>Billing information</h3>
          <Button disabled={portalUnavailable} onClick={onPortal}>
            Edit <ExternalLink aria-hidden="true" />
          </Button>
        </div>
        <p className="billing-muted">
          Manage your billing name, email and address in Stripe.
        </p>
      </section>
      <section className="billing-group">
        <div className="billing-section-heading">
          <h3>Payment methods</h3>
          <Button disabled={portalUnavailable} onClick={onPortal}>
            Manage <ExternalLink aria-hidden="true" />
          </Button>
        </div>
        <p className="billing-muted">
          Update the payment method for your subscription.
        </p>
      </section>
      {paid && (
        <section className="billing-row billing-cancel">
          <div>
            <h3>Cancel plan</h3>
            <p>
              You’ll keep paid access until the end of your billing period.
              Review cancellation in Stripe.
            </p>
          </div>
          <Button
            variant="danger"
            disabled={portalUnavailable}
            onClick={onPortal}
          >
            Manage subscription <ExternalLink aria-hidden="true" />
          </Button>
        </section>
      )}
      {plan.checkout === "unavailable" && (
        <p className="billing-footnote">
          Subscriptions and billing management are not open yet.
        </p>
      )}
      {plan.checkout === "test" && (
        <p className="billing-footnote">
          Test mode. No real payments are taken.
        </p>
      )}
    </div>
  );
}

export function PlanSettings({
  section = "billing",
  comparison = false,
  onCompare = () => {},
}: {
  section?: PlanSettingsSection;
  comparison?: boolean;
  onCompare?: () => void;
} = {}) {
  const { plan, error, refresh } = usePlan();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const noticeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
  async function checkout(action: "checkout" | "portal") {
    setBusy(true);
    setNotice("");
    try {
      const result = await api<{ url: string }>(`/billing/${action}`, {
        id: crypto.randomUUID(),
      });
      const target = new URL(result.url);
      if (
        target.protocol !== "https:" ||
        !["checkout.stripe.com", "billing.stripe.com"].includes(target.hostname)
      )
        throw new Error(
          "The payment link could not be verified. Please try again.",
        );
      window.location.assign(target.href);
    } catch (error) {
      setNotice((error as Error).message);
      setBusy(false);
    }
  }
  if (!plan)
    return (
      <div className="billing-empty" role={error ? "alert" : "status"}>
        <p>{error || "Loading your plan…"}</p>
        {error && <Button onClick={() => void refresh()}>Try again</Button>}
      </div>
    );
  return (
    <>
      {comparison ? (
        <Comparison
          plan={plan}
          busy={busy}
          onCheckout={(action) => void checkout(action)}
        />
      ) : section === "billing" ? (
        <Billing
          plan={plan}
          busy={busy}
          onCompare={onCompare}
          onPortal={() => void checkout("portal")}
        />
      ) : (
        <Usage plan={plan} />
      )}
      {(notice || error) && (
        <p ref={noticeRef} tabIndex={-1} className="billing-error" role="alert">
          {notice || error}
        </p>
      )}
    </>
  );
}
