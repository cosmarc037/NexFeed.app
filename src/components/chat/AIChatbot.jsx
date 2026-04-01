import { useState, useRef, useEffect } from 'react';
import { MessageCircle, X, Send, Loader2, Sparkles, SquarePen } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { chatWithAssistant } from '@/services/azureAI';
import ReactMarkdown from 'react-markdown';
import { motion, AnimatePresence } from 'framer-motion';

const INITIAL_MESSAGE = {
  role: 'assistant',
  content: "Hello! I'm your NexFeed Smart Assistant. I can help you with production scheduling questions, order status, and recommendations. How can I assist you today?"
};

export default function AIChatbot({ orders, hidden }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([INITIAL_MESSAGE]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef(null);
  const sessionIdRef = useRef(0);

  const starterQuestions = [
    "Which orders are urgent and need immediate attention?",
    "What is the current capacity status of all feedmill lines?",
    "Can you summarize today's production schedule?",
  ];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const buildAppState = () => {
    const now = new Date();
    const twoDays = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const urgentOrders = orders.filter(o => {
      if (!o.target_avail_date || o.status === 'completed') return false;
      try { const d = new Date(o.target_avail_date); return d <= twoDays && d >= now; } catch { return false; }
    }).length;

    return {
      totalOrders: orders.length,
      inProduction: orders.filter(o => o.status === 'in_production').length,
      completed: orders.filter(o => o.status === 'completed').length,
      planned: orders.filter(o => ['normal', 'plotted', 'cut', 'combined'].includes(o.status)).length,
      cancelled: orders.filter(o => o.status === 'cancel_po').length,
      categories: [...new Set(orders.map(o => o.category))].filter(Boolean).join(', '),
      feedmillLines: [...new Set(orders.map(o => o.feedmill_line))].filter(Boolean).join(', '),
      totalVolume: orders.reduce((s, o) => s + (o.total_volume_mt || 0), 0).toFixed(1),
      urgentOrders,
    };
  };

  const handleSend = async (questionText) => {
    const userMessage = questionText || input.trim();
    if (!userMessage || isLoading) return;

    const currentSession = sessionIdRef.current;
    setInput('');
    const newMessages = [...messages, { role: 'user', content: userMessage }];
    setMessages(newMessages);
    setIsLoading(true);

    try {
      const chatHistory = newMessages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content }));

      const reply = await chatWithAssistant(chatHistory, buildAppState());
      if (sessionIdRef.current !== currentSession) return;
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (error) {
      if (sessionIdRef.current !== currentSession) return;
      console.error('Chat error:', error);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: "I apologize, but I encountered an error processing your request. Please try again."
      }]);
    }

    if (sessionIdRef.current !== currentSession) return;
    setIsLoading(false);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={hidden ? { display: 'none' } : undefined}>
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            data-testid="button-smart-assistant"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            onClick={() => setIsOpen(true)}
            className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-[#fd5108] text-white shadow-lg hover:bg-[#fe7c39] transition-colors flex items-center justify-center z-50"
          >
            <MessageCircle className="h-6 w-6" />
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className="fixed bottom-6 right-6 w-96 h-[500px] bg-white rounded-2xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden z-50"
            data-testid="panel-smart-assistant"
          >
            <div className="flex items-center justify-between p-4 border-b bg-gradient-to-r from-[#fd5108] to-[#fe7c39]">
              <div className="flex items-center gap-2 text-white">
                <Sparkles className="h-5 w-5" />
                <span className="font-semibold">NexFeed Smart Assistant</span>
              </div>
              <div className="flex items-center gap-1">
                <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      data-testid="button-new-chat"
                      onClick={() => {
                        sessionIdRef.current += 1;
                        setMessages([INITIAL_MESSAGE]);
                        setInput('');
                        setIsLoading(false);
                      }}
                      className="text-white/80 hover:text-white transition-colors p-1"
                    >
                      <SquarePen className="h-[18px] w-[18px]" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    Start a new conversation
                  </TooltipContent>
                </Tooltip>
                </TooltipProvider>
                <button
                  data-testid="button-close-assistant"
                  onClick={() => setIsOpen(false)}
                  className="text-white/80 hover:text-white transition-colors p-1"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <ScrollArea className="flex-1 p-4" ref={scrollRef}>
              <div className="space-y-4">
                {messages.length === 1 && (
                  <div className="space-y-2 mt-2">
                    <p className="text-[12px] text-gray-400 text-center">Try asking:</p>
                    {starterQuestions.map((q, i) => (
                      <button
                        key={i}
                        data-testid={`button-starter-question-${i}`}
                        onClick={() => handleSend(q)}
                        className="w-full text-left text-[12px] bg-gray-50 hover:bg-orange-50 border border-gray-200 hover:border-[#fd5108]/30 rounded-xl px-3 py-2 text-gray-600 transition-colors"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
                {messages.map((message, index) => (
                  <div
                    key={index}
                    className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
                        message.role === 'user'
                          ? 'bg-[#fd5108] text-white'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {message.role === 'user' ? (
                        <p className="text-[12px]">{message.content}</p>
                      ) : (
                        <div className="text-[12px] prose prose-sm max-w-none">
                          <ReactMarkdown>{message.content}</ReactMarkdown>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {isLoading && (
                  <div className="flex justify-start">
                    <div className="bg-gray-100 rounded-2xl px-4 py-2.5">
                      <Loader2 className="h-5 w-5 animate-spin text-gray-500" />
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>

            <div className="p-4 border-t bg-gray-50">
              <div className="flex gap-2">
                <Input
                  data-testid="input-chat-message"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Ask me anything..."
                  className="flex-1 bg-white"
                  disabled={isLoading}
                />
                <Button
                  data-testid="button-send-message"
                  onClick={() => handleSend()}
                  disabled={!input.trim() || isLoading}
                  className="bg-[#fd5108] hover:bg-[#fe7c39]"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
