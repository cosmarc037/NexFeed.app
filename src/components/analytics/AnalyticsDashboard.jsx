import { useState, useCallback, useEffect, useRef } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sparkles,
  Loader2,
  TrendingUp,
  Package,
  Factory,
  RefreshCw,
  CheckCircle2,
  XCircle,
  BarChart2,
  Activity,
  AlertCircle,
} from "lucide-react";
import { generateChartInsight } from "@/services/azureAI";
import {
  fmtVolume,
  fmtHours,
  fmtChangeover,
  fmtRunRate,
} from "../utils/formatters";

function hexToRgb(hex) {
  const c = (hex || "#fd5108").replace("#", "");
  return { r: parseInt(c.slice(0,2),16), g: parseInt(c.slice(2,4),16), b: parseInt(c.slice(4,6),16) };
}
function mixWithWhite(hex, ratio) {
  const { r, g, b } = hexToRgb(hex);
  const to255 = (v) => Math.round(v + (255 - v) * ratio).toString(16).padStart(2,"0");
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

const LINE_CAPACITY = 30;

const insightCache = {};

function getReadiness(order) {
  const numBatches = order.batch_size
    ? Math.ceil(order.total_volume_mt / order.batch_size)
    : 0;
  const hasRequired =
    order.fpr && order.material_code && order.total_volume_mt > 0;
  return hasRequired && order.ha_available === numBatches;
}

function ChartInsightSection({ chartType, chartData, testIdSuffix }) {
  const cached = insightCache[chartType];
  const [insight, setInsight] = useState(cached?.text || "");
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  const fetchInsight = useCallback(
    async (force = false) => {
      const cachedEntry = insightCache[chartType];
      if (
        !force &&
        cachedEntry &&
        Date.now() - cachedEntry.timestamp < 5 * 60 * 1000
      ) {
        setInsight(cachedEntry.text);
        setHasError(cachedEntry.error || false);
        return;
      }
      setIsLoading(true);
      setHasError(false);
      try {
        const result = await generateChartInsight(chartType, chartData);
        const isError = result.startsWith("Unable to generate");
        if (isError) setHasError(true);
        setInsight(result);
        insightCache[chartType] = {
          text: result,
          timestamp: Date.now(),
          error: isError,
        };
      } catch {
        setHasError(true);
        setInsight("Unable to generate insight at this time.");
      }
      setIsLoading(false);
    },
    [chartType, chartData],
  );

  useEffect(() => {
    const cachedEntry = insightCache[chartType];
    if (cachedEntry && Date.now() - cachedEntry.timestamp < 5 * 60 * 1000) {
      setInsight(cachedEntry.text);
      setHasError(cachedEntry.error || false);
    } else if (!isLoading) {
      fetchInsight();
    }
  }, []);

  return (
    <div
      className="mt-3 pt-3"
      style={{ borderTop: '1px solid var(--color-border)' }}
      data-testid={`section-chart-insight-${testIdSuffix}`}
      data-tour="analytics-smart-insight"
    >
      <div className="flex items-start gap-2">
        <div className="p-1.5 rounded-md bg-[color-mix(in_srgb,var(--nexfeed-primary)_10%,transparent)] mt-0.5">
          <Sparkles className="h-3.5 w-3.5 text-[var(--nexfeed-primary)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1 mb-1">
            <span className="text-[13px] font-bold" style={{ color: 'var(--color-text)' }}>
              Smart Insight
            </span>
            <button
              onClick={() => fetchInsight(true)}
              disabled={isLoading}
              data-testid={`button-refresh-insight-${testIdSuffix}`}
              className="text-[13px] text-[var(--nexfeed-primary)] hover:text-[var(--nexfeed-primary-dark)] flex items-center gap-1 disabled:opacity-50 shrink-0"
            >
              <RefreshCw
                className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>
          {isLoading ? (
            <div className="flex items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="text-[13px]">🤖 Generating insights...</span>
            </div>
          ) : hasError ? (
            <div className="flex items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
              <AlertCircle className="h-3.5 w-3.5" />
              <span className="text-[12px]">{insight}</span>
              <button
                onClick={() => fetchInsight(true)}
                className="text-[12px] text-[var(--nexfeed-primary)] hover:underline ml-1"
              >
                Retry
              </button>
            </div>
          ) : insight ? (
            <div
              className="text-[12px] leading-relaxed whitespace-pre-line"
              style={{ color: 'var(--color-text)' }}
              data-testid={`text-chart-insight-${testIdSuffix}`}
            >
              {insight}
            </div>
          ) : (
            <div className="flex items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="text-[12px]">🤖 Generating insights...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getPrimaryColor() {
  return getComputedStyle(document.documentElement).getPropertyValue("--nexfeed-primary").trim() || "#fd5108";
}
function getPrimaryDarkColor() {
  return getComputedStyle(document.documentElement).getPropertyValue("--nexfeed-primary-dark").trim() || "#fe7c39";
}

export default function AnalyticsDashboard({ orders }) {
  const [primaryColor, setPrimaryColor] = useState(getPrimaryColor);
  const [primaryDark, setPrimaryDark] = useState(getPrimaryDarkColor);
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('nexfeed-dark'));

  useEffect(() => {
    const handleThemeChange = (e) => {
      setPrimaryColor(e.detail?.primary || getPrimaryColor());
      setPrimaryDark(e.detail?.dark || getPrimaryDarkColor());
      setIsDark(document.documentElement.classList.contains('nexfeed-dark'));
    };
    window.addEventListener("nexfeed-theme-change", handleThemeChange);
    return () => window.removeEventListener("nexfeed-theme-change", handleThemeChange);
  }, []);

  const chartCursor = isDark ? { fill: 'rgba(255,255,255,0.08)' } : { fill: 'rgba(0,0,0,0.07)' };

  const CHART_COLORS = [
    primaryColor,
    primaryDark,
    mixWithWhite(primaryColor, 0.40),
    mixWithWhite(primaryColor, 0.65),
    "#2e343a",
    "#a1a8b3",
    "#b5bcc4",
  ];

  const totalVolume = orders.reduce((s, o) => s + (o.total_volume_mt || 0), 0);
  const avgSize = orders.length ? totalVolume / orders.length : 0;
  const readyCount = orders.filter(getReadiness).length;
  const completed = orders.filter((o) => o.status === "completed").length;

  const formDist = orders.reduce((acc, o) => {
    acc[o.form || "N/A"] = (acc[o.form || "N/A"] || 0) + 1;
    return acc;
  }, {});
  const formData = Object.entries(formDist).map(([name, value]) => ({
    name,
    value,
  }));

  const lineUsage = {};
  orders
    .filter((o) => o.status === "in_production")
    .forEach((o) => {
      if (o.feedmill_line)
        lineUsage[o.feedmill_line] = (lineUsage[o.feedmill_line] || 0) + 1;
    });
  const lineUtilData = Object.entries(lineUsage).map(([name, value]) => ({
    name,
    value,
    pct: Math.round((value / LINE_CAPACITY) * 100),
  }));

  const volumeByCategory = orders.reduce((acc, order) => {
    const cat = order.category || "Other";
    acc[cat] = (acc[cat] || 0) + (order.total_volume_mt || 0);
    return acc;
  }, {});

  const categoryData = Object.entries(volumeByCategory)
    .map(([name, value]) => ({ name, value: Math.round(value) }))
    .sort((a, b) => b.value - a.value);

  const ordersByLine = orders.reduce((acc, order) => {
    const line = order.feedmill_line || "Unassigned";
    acc[line] = (acc[line] || 0) + 1;
    return acc;
  }, {});

  const lineData = Object.entries(ordersByLine)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  const itemCounts = orders.reduce((acc, order) => {
    const item = order.item_description || "Unknown";
    acc[item] = (acc[item] || 0) + 1;
    return acc;
  }, {});

  const topItems = Object.entries(itemCounts)
    .map(([name, count]) => ({ name: name.substring(0, 30), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const sharedContext = { totalVolume, totalOrders: orders.length, completed };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" data-tour="analytics-metrics">
        {[
          {
            label: "Total Volume",
            value: `${fmtVolume(totalVolume)} MT`,
            icon: Package,
            color: "text-gray-600",
            bg: "bg-gray-50",
          },
          {
            label: "Avg Order Size",
            value: `${fmtVolume(avgSize)} MT`,
            icon: BarChart2,
            color: "text-gray-600",
            bg: "bg-gray-50",
          },
          {
            label: "Completed",
            value: completed,
            icon: CheckCircle2,
            color: "text-gray-600",
            bg: "bg-gray-50",
          },
          {
            label: "Total Orders",
            value: orders.length,
            icon: TrendingUp,
            color: "text-gray-600",
            bg: "bg-gray-50",
          },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <Card
            key={label}
            className="border-0 shadow-sm"
            data-testid={`card-analytics-${label.toLowerCase().replace(/\s/g, "-")}`}
          >
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[12px] mb-1" style={{ color: 'var(--color-text-muted)' }}>{label}</p>
                  <p className="text-[24px] font-bold" style={{ color: 'var(--color-text)' }}>{value}</p>
                </div>
                <div className={`p-2.5 rounded-xl ${bg}`}>
                  <Icon className={`h-5 w-5 ${color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" data-tour="analytics-charts">
        <Card className="border-0 shadow-sm" data-tour="analytics-volume-category">
          <CardHeader className="pb-6">
            <CardTitle className="text-[16px] flex items-center gap-2">
              <Package className="h-6 w-6 text-[var(--nexfeed-primary)]" />
              Volume by Category (MT)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categoryData.slice(0, 6)} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis type="number" tick={{ fontSize: 12, fill: 'var(--color-text-muted)' }} />
                  <YAxis dataKey="name" type="category" width={100} tick={{ fontSize: 12, fill: 'var(--color-text-muted)' }} />
                  <Tooltip
                    cursor={chartCursor}
                    contentStyle={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: '8px', color: 'var(--color-text)' }}
                    itemStyle={{ color: 'var(--color-text)' }}
                    labelStyle={{ color: 'var(--color-text)' }}
                  />
                  <Bar dataKey="value" fill={primaryColor} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <ChartInsightSection
              chartType="volumeByCategory"
              chartData={{ categoryData, ...sharedContext }}
              testIdSuffix="volume-category"
            />
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm" data-tour="analytics-orders-line">
          <CardHeader className="pb-6">
            <CardTitle className="text-[16px] flex items-center gap-2">
              <Factory className="h-6 w-6 text-[var(--nexfeed-primary)]" />
              Orders by Feedmill Line
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={lineData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}`}
                    labelLine={false}
                    stroke="var(--color-bg-secondary)"
                    strokeWidth={2}
                  >
                    {lineData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: '8px', color: 'var(--color-text)' }}
                    itemStyle={{ color: 'var(--color-text)' }}
                    labelStyle={{ color: 'var(--color-text)' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ChartInsightSection
              chartType="ordersByLine"
              chartData={{ lineData, ...sharedContext }}
              testIdSuffix="orders-line"
            />
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm lg:col-span-2" data-tour="analytics-top-items">
          <CardHeader className="pb-6">
            <CardTitle className="text-[16px] flex items-center gap-2">
              <TrendingUp className="h-6 w-6 text-[var(--nexfeed-primary)]" />
              Top 5 Most Ordered Items
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topItems}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 12, fill: 'var(--color-text-muted)' }} angle={-15} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 12, fill: 'var(--color-text-muted)' }} />
                  <Tooltip
                    cursor={chartCursor}
                    contentStyle={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: '8px', color: 'var(--color-text)' }}
                    itemStyle={{ color: 'var(--color-text)' }}
                    labelStyle={{ color: 'var(--color-text)' }}
                  />
                  <Bar dataKey="count" fill={primaryDark} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <ChartInsightSection
              chartType="topItems"
              chartData={{ topItems, ...sharedContext }}
              testIdSuffix="top-items"
            />
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-6">
            <CardTitle className="text-[16px] flex items-center gap-2">
              <Package className="h-6 w-6 text-[var(--nexfeed-primary)]" />
              Form Type Distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={formData}
                    cx="50%"
                    cy="50%"
                    innerRadius={40}
                    outerRadius={70}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}`}
                    labelLine={false}
                    stroke="var(--color-bg-secondary)"
                    strokeWidth={2}
                  >
                    {formData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: '8px', color: 'var(--color-text)' }}
                    itemStyle={{ color: 'var(--color-text)' }}
                    labelStyle={{ color: 'var(--color-text)' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ChartInsightSection
              chartType="formDistribution"
              chartData={{ formData, ...sharedContext }}
              testIdSuffix="form-distribution"
            />
          </CardContent>
        </Card>

        {/* Line Utilization hidden — restore by removing the surrounding false && */}
        {false && (
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-6">
            <CardTitle className="text-[16px] flex items-center gap-2">
              <Factory className="h-6 w-6 text-[var(--nexfeed-primary)]" />
              Line Utilization (%)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={lineUtilData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 12, fill: 'var(--color-text-muted)' }} />
                  <YAxis dataKey="name" type="category" width={60} tick={{ fontSize: 12, fill: 'var(--color-text-muted)' }} />
                  <Tooltip
                    formatter={(v) => `${v}%`}
                    cursor={chartCursor}
                    contentStyle={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: '8px', color: 'var(--color-text)' }}
                    itemStyle={{ color: 'var(--color-text)' }}
                    labelStyle={{ color: 'var(--color-text)' }}
                  />
                  <Bar dataKey="pct" fill={primaryColor} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <ChartInsightSection
              chartType="lineUtilization"
              chartData={{
                lineUtilData,
                lineCapacity: LINE_CAPACITY,
                ...sharedContext,
              }}
              testIdSuffix="line-utilization"
            />
          </CardContent>
        </Card>
        )}
      </div>
    </div>
  );
}
