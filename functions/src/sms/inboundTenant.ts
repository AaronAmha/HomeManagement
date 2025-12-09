// export const smsInbound = functions.https.onRequest(async (req, res) => {
//   const from = req.body.From;
//   const body = req.body.Body;

//   await firestore.collection('inbound_messages').add({
//     from,
//     body,
//     timestamp: Date.now()
//   });

//   res.send(`<Response><Message>Thanks — got your message.</Message></Response>`);
// });