import { useState, useEffect, useCallback, useRef } from 'react';
import { Sparkles, RefreshCw, Loader2, X } from 'lucide-react';
import { generateSmartRecommendations } from '@/services/azureAI';
import { AIText } from '@/lib/renderAIText';

export default function SmartRecommendations({ orders, activeSection, activeSubSection, activeFeedmill }) {
  const [recommendation, setRecommendation] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState(false);
  const fetchedForRef = useRef('');

  const isCompletedTab = activeSection === 'production' && activeSubSection === 'completed';
  const contextKey = `${activeSection}|${activeSubSection}|${activeFeedmill}|${orders.length}`;

  useEffect(() => {
    setDismissed(false);
    setRecommendation('');
    setError(false);
    fetchedForRef.current = '';
  }, [activeSection, activeSubSection, activeFeedmill]);

  const doFetch = useCallback(async (ordersList) => {
    if (ordersList.length === 0) return;
    setIsLoading(true);
    setRecommendation('');
    setError(false);
    try {
      const result = await generateSmartRecommendations(ordersList, {
        activeSection,
        activeSubSection,
        activeFeedmill,
      });
      if (result) {
        setRecommendation(result);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
    setIsLoading(false);
  }, [activeSection, activeSubSection, activeFeedmill]);

  useEffect(() => {
    if (isCompletedTab || orders.length === 0) return;
    if (fetchedForRef.current === contextKey) return;
    fetchedForRef.current = contextKey;
    doFetch(orders);
  }, [contextKey, isCompletedTab, doFetch, orders]);

  if (dismissed) return null;
  if (isCompletedTab) return null;

  if (!isLoading && orders.length === 0) {
    return (
      <div className="bg-[#fff5ed] border border-[#ffcda8] rounded-lg px-5 py-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="p-1.5 rounded bg-[#fd5108]/10">
            <Sparkles className="h-4 w-4 text-[#fd5108]" />
          </div>
          <span className="text-sm font-semibold text-[#fd5108]">Smart Recommendations</span>
        </div>
        <p className="text-sm text-gray-500 mt-1" data-testid="text-recommendations-empty">
          No orders available. Upload SAP planned orders to receive smart recommendations.
        </p>
      </div>
    );
  }

  if (!isLoading && !recommendation && !error) return null;

  return (
    <div className="bg-[#fff5ed] border border-[#ffcda8] rounded-lg px-5 py-4" data-testid="section-smart-recommendations">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded bg-[#fd5108]/10">
            <Sparkles className="h-4 w-4 text-[#fd5108]" />
          </div>
          <span className="text-sm font-semibold text-[#fd5108]">Smart Recommendations</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { fetchedForRef.current = ''; doFetch(orders); }}
            disabled={isLoading}
            title="Refresh Smart Recommendations"
            data-testid="button-refresh-recommendations"
            className="flex items-center gap-1 text-xs text-[#fd5108] hover:text-[#fe7c39] disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button onClick={() => setDismissed(true)} className="text-gray-400 hover:text-gray-600 ml-1" data-testid="button-dismiss-recommendations">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Generating recommendations...
        </div>
      ) : error ? (
        <p className="text-sm text-gray-400">Smart recommendations unavailable. Click refresh to try again.</p>
      ) : (
        <div data-testid="text-recommendations-content">
          <AIText text={recommendation} fontSize={13} color="#374151" lineHeight={1.6} gap={6} />
        </div>
      )}
    </div>
  );
}
