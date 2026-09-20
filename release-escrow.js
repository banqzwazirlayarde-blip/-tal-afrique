// api/release-escrow.js
// Déclenché périodiquement par Vercel Cron (voir vercel.json).
// Trouve les commandes dont l'escrow de 48h est écoulé et déclenche
// le reversement (payout) FedaPay vers le numéro Mobile Money du vendeur.

const { createClient } = require('@supabase/supabase-js');
const { FedaPay, Payout } = require('fedapay');

module.exports = async (req, res) => {
  // Vercel Cron appelle cette route avec un en-tête d'autorisation ;
  // on vérifie un secret partagé pour empêcher n'importe qui d'appeler
  // cette route et de déclencher des paiements.
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).end();
    return;
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
  FedaPay.setEnvironment(process.env.FEDAPAY_ENVIRONMENT || 'sandbox');

  const { data: dueOrders, error } = await supabase
    .from('orders')
    .select('*, stalls(momo_number, momo_operator, name)')
    .eq('status', 'paid_escrow')
    .lte('escrow_release_at', new Date().toISOString());

  if (error) {
    console.error('Erreur lecture commandes dues :', error);
    res.status(500).json({ error: 'Erreur lecture des commandes' });
    return;
  }

  const results = [];
  for (const order of dueOrders || []) {
    const momoNumber = order.stalls?.momo_number;
    if (!momoNumber) {
      console.error(`Commande ${order.id} : vendeur sans numéro Mobile Money, reversement impossible.`);
      continue;
    }
    try {
      const payout = await Payout.create({
        amount: order.payout_amount,
        currency: { iso: 'XOF' },
        mode: order.stalls?.momo_operator || undefined,
        description: `ÉtalAfrique — vente ${order.product_name}`,
        customer: { phone_number: { number: momoNumber, country: 'bj' } },
      });
      await supabase
        .from('orders')
        .update({ status: 'released', fedapay_payout_id: String(payout.id) })
        .eq('id', order.id);
      results.push({ orderId: order.id, payoutId: payout.id, status: 'ok' });
    } catch (err) {
      console.error(`Échec du reversement pour la commande ${order.id} :`, err);
      results.push({ orderId: order.id, status: 'failed', error: err.message });
    }
  }

  res.status(200).json({ processed: results.length, results });
};
