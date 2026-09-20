// api/create-transaction.js
// Reçoit { orderId } depuis le site, vérifie la commande via la clé
// service_role Supabase (qui contourne RLS), crée la transaction FedaPay
// correspondante et renvoie l'URL de paiement à ouvrir côté client.
//
// Variables d'environnement requises (à définir dans Vercel → Settings → Environment Variables) :
//   SUPABASE_URL               (même valeur que côté client)
//   SUPABASE_SERVICE_ROLE_KEY  (Project Settings → API → service_role — SECRÈTE, jamais côté client)
//   FEDAPAY_SECRET_KEY         (clé secrète FedaPay, sandbox d'abord)
//   FEDAPAY_ENVIRONMENT        'sandbox' ou 'live'
//   SITE_URL                   ex: https://etal-afrique.vercel.app

const { createClient } = require('@supabase/supabase-js');
const { FedaPay, Transaction } = require('fedapay');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée' });
    return;
  }

  try {
    const { orderId } = req.body || {};
    if (!orderId) {
      res.status(400).json({ error: 'orderId manquant' });
      return;
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // On relit la commande depuis la base : jamais confiance dans un montant
    // envoyé par le navigateur, on ne fait confiance qu'à ce qui est déjà
    // enregistré côté serveur.
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (orderErr || !order) {
      res.status(404).json({ error: 'Commande introuvable' });
      return;
    }
    if (order.status !== 'pending') {
      res.status(409).json({ error: 'Cette commande a déjà été traitée' });
      return;
    }

    FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
    FedaPay.setEnvironment(process.env.FEDAPAY_ENVIRONMENT || 'sandbox');

    const transaction = await Transaction.create({
      description: `ÉtalAfrique — ${order.product_name}`,
      amount: order.amount,
      currency: { iso: 'XOF' },
      callback_url: `${process.env.SITE_URL}/#seller-space`,
      customer: order.buyer_phone
        ? { phone_number: { number: order.buyer_phone, country: 'bj' } }
        : undefined,
    });

    const { url } = await transaction.generateToken();

    await supabase
      .from('orders')
      .update({ fedapay_transaction_id: String(transaction.id) })
      .eq('id', orderId);

    res.status(200).json({ url });
  } catch (err) {
    console.error('create-transaction error:', err);
    res.status(500).json({ error: 'Erreur lors de la création du paiement' });
  }
};
