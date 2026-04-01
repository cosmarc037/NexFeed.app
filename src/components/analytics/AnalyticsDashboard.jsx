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

const COLORS = [
  "#fd5108",
  "#fe7c39",
  "#ffaa72",
  "#ffcda8",
  "#2e343a",
  "#a1a8b3",
  "#b5bcc4",
];

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
      className="mt-3 pt-3 border-t border-gray-100"
      data-testid={`section-chart-insight-${testIdSuffix}`}
    >
      <div className="flex items-start gap-2">
        <div className="p-1.5 rounded-md bg-[#fd5108]/10 mt-0.5">
          <Sparkles className="h-3.5 w-3.5 text-[#fd5108]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1 mb-1">
            <span className="text-[13px] font-bold text-gray-700">
              Smart Insight
            </span>
            <button
              onClick={() => fetchInsight(true)}
              disabled={isLoading}
              data-testid={`button-refresh-insight-${testIdSuffix}`}
              className="text-[13px] text-[#fd5108] hover:text-[#fe7c39] flex items-center gap-1 disabled:opacity-50 shrink-0"
            >
              <RefreshCw
                className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>
          {isLoading ? (
            <div className="flex items-center gap-2 text-gray-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="text-[13px]">🤖 Generating insights...</span>
            </div>
          ) : hasError ? (
            <div className="flex items-center gap-2 text-gray-400">
              <AlertCircle className="h-3.5 w-3.5" />
              <span className="text-[12px]">{insight}</span>
              <button
                onClick={() => fetchInsight(true)}
                className="text-[12px] text-[#fd5108] hover:underline ml-1"
              >
                Retry
              </button>
            </div>
          ) : insight ? (
            <div
              className="text-[12px] text-gray-600 leading-relaxed whitespace-pre-line"
              data-testid={`text-chart-insight-${testIdSuffix}`}
            >
              {insight}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-gray-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="text-[12px]">🤖 Generating insights...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AnalyticsDashboard({ orders }) {
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          {
            label: "Total Volume",
            value: `${fmtVolume(totalVolume)} MT`,
            icon: Package,
            color: "text-blue-600",
            bg: "bg-blue-50",
          },
          {
            label: "Avg Order Size",
            value: `${fmtVolume(avgSize)} MT`,
            icon: BarChart2,
            color: "text-purple-600",
            bg: "bg-purple-50",
          },
          {
            label: "Completed",
            value: completed,
            icon: CheckCircle2,
            color: "text-teal-600",
            bg: "bg-teal-50",
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
                  <p className="text-[12px] text-gray-500 mb-1">{label}</p>
                  <p className="text-[24px] font-bold text-gray-900">{value}</p>
                </div>
                <div className={`p-2.5 rounded-xl ${bg}`}>
                  <Icon className={`h-5 w-5 ${color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-6">
            <CardTitle className="text-[16px] flex items-center gap-2">
              <Package className="h-6 w-6 text-[#fd5108]" />
              Volume by Category (MT)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categoryData.slice(0, 6)} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis type="number" tick={{ fontSize: 12 }} />
                  <YAxis
                    dataKey="name"
                    type="category"
                    width={100}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#fff",
                      border: "1px solid #e5e7eb",
                      borderRadius: "8px",
                    }}
                  />
                  <Bar dataKey="value" fill="#fd5108" radius={[0, 4, 4, 0]} />
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

        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-6">
            <CardTitle className="text-[16px] flex items-center gap-2">
              <Factory className="h-6 w-6 text-[#fd5108]" />
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
                  >
                    {lineData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={COLORS[index % COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip />
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

        <Card className="border-0 shadow-sm lg:col-span-2">
          <CardHeader className="pb-6">
            <CardTitle className="text-[16px] flex items-center gap-2">
              <TrendingUp className="h-6 w-6 text-[#fd5108]" />
              Top 5 Most Ordered Items
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topItems}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 12 }}
                    angle={-15}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#fff",
                      border: "1px solid #e5e7eb",
                      borderRadius: "8px",
                    }}
                  />
                  <Bar dataKey="count" fill="#fe7c39" radius={[4, 4, 0, 0]} />
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
              <Package className="h-6 w-6 text-[#fd5108]" />
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
                  >
                    {formData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
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

        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-6">
            <CardTitle className="text-[16px] flex items-center gap-2">
              <Factory className="h-6 w-6 text-[#fd5108]" />
              Line Utilization (%)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={lineUtilData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis
                    type="number"
                    domain={[0, 100]}
                    tickFormatter={(v) => `${v}%`}
                    tick={{ fontSize: 12 }}
                  />
                  <YAxis
                    dataKey="name"
                    type="category"
                    width={60}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip
                    formatter={(v) => `${v}%`}
                    contentStyle={{
                      backgroundColor: "#fff",
                      border: "1px solid #e5e7eb",
                      borderRadius: "8px",
                    }}
                  />
                  <Bar dataKey="pct" fill="#fd5108" radius={[0, 4, 4, 0]} />
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
      </div>
    </div>
  );
}
