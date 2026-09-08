import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";

interface GrowthConfig {
  business: { name: string; domain: string };
  keywords: string[];
  competitors: string[];
}

/** Direct-manipulation editor for what the agent tracks. */
export function TrackingPanel({ config }: { config: GrowthConfig }) {
  const save = useMutation(api.admin.setGrowthConfig);
  const [name, setName] = useState(config.business.name);
  const [domain, setDomain] = useState(config.business.domain);

  function saveBusiness() {
    const cleanDomain = normalizeDomain(domain);
    if (!cleanDomain || (name === config.business.name && cleanDomain === config.business.domain)) return;
    save({ business: { name: name.trim() || cleanDomain, domain: cleanDomain } });
  }

  return (
    <section className="obs-col tracking">
      <span className="eyebrow">Configuration</span>
      <h2>What the agent tracks</h2>

      <label className="field">
        <span>Your business</span>
        <div className="field-row">
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={saveBusiness} placeholder="Name" aria-label="Business name" />
          <input value={domain} onChange={(e) => setDomain(e.target.value)} onBlur={saveBusiness} placeholder="domain.com" aria-label="Business domain" />
        </div>
      </label>

      <ChipEditor
        label="Target keywords"
        placeholder="add a keyword…"
        items={config.keywords}
        onChange={(keywords) => save({ keywords })}
        normalize={(s) => s.trim().toLowerCase()}
      />
      <ChipEditor
        label="Competitors"
        placeholder="competitor.com"
        items={config.competitors}
        onChange={(competitors) => save({ competitors })}
        normalize={normalizeDomain}
      />
      <p className="quiet">
        Changes apply from the next check. One search query per keyword per
        check, no matter how many competitors.
      </p>
    </section>
  );
}

function ChipEditor({
  label,
  placeholder,
  items,
  onChange,
  normalize,
}: {
  label: string;
  placeholder: string;
  items: string[];
  onChange: (items: string[]) => void;
  normalize: (raw: string) => string;
}) {
  const [value, setValue] = useState("");

  function add(event: React.FormEvent) {
    event.preventDefault();
    const item = normalize(value);
    if (!item || items.includes(item)) return;
    onChange([...items, item]);
    setValue("");
  }

  return (
    <div className="field">
      <span>{label}</span>
      <div className="chips">
        {items.map((item) => (
          <span key={item} className="chip-tag">
            {item}
            <button
              type="button"
              aria-label={`Remove ${item}`}
              onClick={() => onChange(items.filter((i) => i !== item))}
            >
              ×
            </button>
          </span>
        ))}
        <form onSubmit={add} className="chip-add">
          <input
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            aria-label={label}
          />
        </form>
      </div>
    </div>
  );
}

function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}
