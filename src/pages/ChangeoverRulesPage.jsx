import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import toast from "react-hot-toast";

export function getDefaultChangeoverRules() {
  try {
    const saved = localStorage.getItem("nexfeed_changeover_rules");
    if (saved) return JSON.parse(saved);
  } catch {}
  return [
    {
      id: "diameter_change",
      title: "Change Pellet Diameter (4mm ↔ 3mm)",
      reason: "Change Die",
      icon: "🔵",
      type: "diameter",
      values: { fm1: 1.50, fm2: 1.00, fm3: 1.00 },
    },
    {
      id: "yellow_brown",
      title: "Change Color: Yellow ↔ Brown",
      reason: "Cleaning",
      icon: "🟡",
      type: "color_yellow_brown",
      values: { fm1: 0.33, fm2: 0.33, fm3: 0.33 },
    },
    {
      id: "red_to_any",
      title: "Change Color: Red → Any",
      reason: "Flushing and Cleaning",
      icon: "🔴",
      type: "color_red_out",
      values: { fm1: 1.00, fm2: 1.00, fm3: 1.00 },
    },
    {
      id: "green_to_any",
      title: "Change Color: Green → Any",
      reason: "Flushing and Cleaning",
      icon: "🟢",
      type: "color_green_out",
      values: { fm1: 1.00, fm2: 1.00, fm3: 1.00 },
    },
    {
      id: "any_to_red_green",
      title: "Change Color: Any → Red/Green",
      reason: "Cleaning",
      icon: "🔴🟢",
      type: "color_to_red_green",
      values: { fm1: 0.50, fm2: 0.50, fm3: 0.50 },
    },
    {
      id: "category_change",
      title: "Change Category (Different Category)",
      reason: "Cleaning",
      icon: "📦",
      type: "category",
      values: { fm1: 0.33, fm2: 0.33, fm3: 0.33 },
    },
  ];
}

export function saveChangeoverRules(rules) {
  try {
    localStorage.setItem("nexfeed_changeover_rules", JSON.stringify(rules));
  } catch {}
}

function ChangeoverRuleCard({ rule, onValueChange }) {
  return (
    <div className="changeover-rule-card">
      <div className="changeover-rule-header">
        <span className="changeover-rule-icon">{rule.icon}</span>
        <div className="changeover-rule-info">
          <span className="changeover-rule-title">{rule.title}</span>
          <span className="changeover-rule-reason">Reason: {rule.reason}</span>
        </div>
      </div>
      <div className="changeover-rule-values">
        {["fm1", "fm2", "fm3"].map((fm) => (
          <div key={fm} className="changeover-rule-field">
            <label>{fm.toUpperCase()}</label>
            <div className="changeover-input-wrapper">
              <input
                type="number"
                step="0.01"
                min="0"
                value={rule.values[fm]}
                onChange={(e) => onValueChange(rule.id, fm, e.target.value)}
              />
              <span className="changeover-input-unit">hrs</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ChangeoverRulesPage({ onSave }) {
  const [rules, setRules] = useState(() => getDefaultChangeoverRules());
  const [hasChanges, setHasChanges] = useState(false);

  function handleValueChange(ruleId, feedmill, value) {
    setRules((prev) =>
      prev.map((rule) =>
        rule.id === ruleId
          ? { ...rule, values: { ...rule.values, [feedmill]: parseFloat(value) || 0 } }
          : rule
      )
    );
    setHasChanges(true);
  }

  function handleSave() {
    saveChangeoverRules(rules);
    setHasChanges(false);
    toast.success("Changeover rules saved. All order changeovers will recalculate.");
    if (onSave) onSave(rules);
  }

  return (
    <div className="changeover-rules-page">
      <div className="changeover-rules-header">
        <div>
          <h2 className="changeover-rules-title">
            <SlidersHorizontal size={18} style={{ display: "inline", marginRight: 8, verticalAlign: "text-bottom" }} />
            Changeover Rules
          </h2>
          <p className="changeover-rules-subtitle">
            Configure additional changeover times based on product transitions
          </p>
        </div>
        <button
          className="btn-save-changeover"
          onClick={handleSave}
          disabled={!hasChanges}
        >
          Save Changes
        </button>
      </div>

      <div className="changeover-rules-description">
        <p>
          These rules add extra changeover time when consecutive orders differ in
          pellet diameter, color, or category. The additions are calculated automatically
          based on the following order's properties and stack if multiple conditions apply.
          Powermix (Line 5) is not affected by these rules.
        </p>
      </div>

      <div className="changeover-rules-cards">
        {rules.map((rule) => (
          <ChangeoverRuleCard
            key={rule.id}
            rule={rule}
            onValueChange={handleValueChange}
          />
        ))}
      </div>
    </div>
  );
}
