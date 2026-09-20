// api/fedapay-webhook.js
// Point d'entrée que FedaPay appelle pour notifier l'issue d'un paiement.
// On vérifie la signature (en-tête X-FEDAPAY-SIGNATURE) avant de faire
// confiance à quoi que ce soit dans le corps de la requête.
//
// À configurer dans le dashboard FedaPay → Développement → Webhooks :
//   URL : https://<ton-site>.vercel.app/api/fedapay-webhook
//   Événements : transaction.approved, transaction.declined, transaction.canceled
//
// Variables d'environnement requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   FEDAPAY_WEBHOOK_SECRET   (copié depuis les paramètres du webhook, PAS la clé API)

const { createClient } = require('@supabase/supabase-js');
const { Webhook } = require('fedapay');

// Lit le corps brut de la requête : la vérification de signature FedaPay
// a besoin des octets exacts envoyés, pas d'un objet déjà parsé en JSON.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-fedapay-signature'];

  let event;
  try {
    event = Webhook.constructEvent(rawBody, signature, process.env.FEDAPAY_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook invalide :', err.message);
    res.status(400).send('Signature invalide');
    return;
  }

  // On répond 200 tout de suite : FedaPay retente l'envoi si on met trop
  // de temps à répondre. Le traitement se fait avant, mais reste rapide.
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    const transaction = event.data?.object || event.data;
    const transactionId = String(transaction?.id ?? '');

    if (event.name === 'transaction.approved') {
      const releaseAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      await supabase
        .from('orders')
        .update({ status: 'paid_escrow', escrow_release_at: releaseAt })
        .eq('fedapay_transaction_id', transactionId)
        .eq('status', 'pending');
    } else if (['transaction.declined', 'transaction.canceled'].includes(event.name)) {
      await supabase
        .from('orders')
        .update({ status: 'failed' })
        .eq('fedapay_transaction_id', transactionId)
        .eq('status', 'pending');
    }
    // Autres événements (transaction.created, etc.) : rien à faire ici.
  } catch (err) {
    console.error('Erreur traitement webhook :', err);
    // On répond quand même 200 pour éviter des tentatives infinies de FedaPay ;
    // l'erreur reste visible dans les logs Vercel pour investigation.
  }

  res.status(200).json({ received: true });
};
