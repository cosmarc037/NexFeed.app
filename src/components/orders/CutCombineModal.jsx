import React, { useState } from 'react';
import { Scissors, Combine, X, CheckCircle2 } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export default function CutCombineModal({ 
  isOpen, 
  onClose, 
  order, 
  eligibleOrders,
  onCut, 
  onCombine 
}) {
  const [activeTab, setActiveTab] = useState('cut');
  const [cutAmount, setCutAmount] = useState('');
  const [selectedOrders, setSelectedOrders] = useState([]);

  if (!order) return null;

  const handleCut = () => {
    const amount = parseFloat(cutAmount);
    if (amount > 0 && amount < order.total_volume_mt) {
      onCut(order, amount);
      handleClose();
    }
  };

  const handleCombine = () => {
    if (selectedOrders.length > 0) {
      onCombine(order, selectedOrders);
      handleClose();
    }
  };

  const handleClose = () => {
    setCutAmount('');
    setSelectedOrders([]);
    setActiveTab('cut');
    onClose();
  };

  const toggleOrderSelection = (orderId) => {
    setSelectedOrders(prev => 
      prev.includes(orderId)
        ? prev.filter(id => id !== orderId)
        : [...prev, orderId]
    );
  };

  const remainingMT = order.total_volume_mt - (parseFloat(cutAmount) || 0);

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Cut / Combine Order</DialogTitle>
          <DialogDescription>
            {order.item_description} - {order.total_volume_mt} MT
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="cut" className="gap-2">
              <Scissors className="h-4 w-4" />
              Cut
            </TabsTrigger>
            <TabsTrigger value="combine" className="gap-2">
              <Combine className="h-4 w-4" />
              Combine
            </TabsTrigger>
          </TabsList>

          <TabsContent value="cut" className="space-y-4 pt-4">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-sm text-gray-600 mb-2">Current Volume</p>
              <p className="text-2xl font-bold text-gray-900">{order.total_volume_mt} MT</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="cutAmount">Amount to Keep for Production (MT)</Label>
              <Input
                id="cutAmount"
                type="number"
                min="0"
                max={order.total_volume_mt}
                step="0.1"
                value={cutAmount}
                onChange={(e) => setCutAmount(e.target.value)}
                placeholder="Enter MT to keep"
              />
            </div>

            {cutAmount && parseFloat(cutAmount) > 0 && (
              <div className="grid grid-cols-2 gap-4 pt-2">
                <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                  <p className="text-xs text-green-600 mb-1">Keep for Production</p>
                  <p className="text-lg font-bold text-green-700">{cutAmount} MT</p>
                </div>
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
                  <p className="text-xs text-orange-600 mb-1">Move to Pending Orders</p>
                  <p className="text-lg font-bold text-orange-700">
                    {remainingMT > 0 ? remainingMT.toFixed(1) : 0} MT
                  </p>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
              <Button 
                onClick={handleCut}
                disabled={!cutAmount || parseFloat(cutAmount) <= 0 || parseFloat(cutAmount) >= order.total_volume_mt}
                className="bg-[#fd5108] hover:bg-[#fe7c39]"
              >
                <Scissors className="h-4 w-4 mr-2" />
                Cut Order
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="combine" className="space-y-4 pt-4">
            <p className="text-sm text-gray-600">
              Select orders with the same Material Code to combine:
            </p>

            <div className="max-h-64 overflow-y-auto space-y-2">
              {eligibleOrders.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <p>No eligible orders found for combining.</p>
                  <p className="text-xs mt-1">Orders must have the same Material Code.</p>
                </div>
              ) : (
                eligibleOrders.map(eo => {
                  const sourceTag = eo.status === 'cut' ? 'Pending' : 'Normal';
                  const tagColor = eo.status === 'cut' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700';
                  return (
                    <div 
                      key={eo.id}
                      className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-gray-300 cursor-pointer transition-all"
                      onClick={() => toggleOrderSelection(eo.id)}
                    >
                      <div className="w-5 h-5 flex items-center justify-center rounded border border-[#cbd1d6] hover:border-[#a1a8b3] shrink-0 transition-colors">
                        {selectedOrders.includes(eo.id) && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${tagColor}`}>{sourceTag}</span>
                          <p className="text-sm font-medium text-gray-900 truncate">{eo.item_description}</p>
                        </div>
                        <p className="text-xs text-gray-500">
                          FPR: {eo.fpr} — {eo.total_volume_mt} MT
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {selectedOrders.length > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-xs text-blue-600 mb-1">Combined Total</p>
                <p className="text-lg font-bold text-blue-700">
                  {(order.total_volume_mt + eligibleOrders
                    .filter(eo => selectedOrders.includes(eo.id))
                    .reduce((sum, eo) => sum + (eo.total_volume_mt || 0), 0)
                  ).toFixed(1)} MT
                </p>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
              <Button 
                onClick={handleCombine}
                disabled={selectedOrders.length === 0}
                className="bg-[#fd5108] hover:bg-[#fe7c39]"
              >
                <Combine className="h-4 w-4 mr-2" />
                Combine Orders
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}