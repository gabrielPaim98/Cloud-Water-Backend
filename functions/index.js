const functions = require("firebase-functions");
const admin = require('firebase-admin');
admin.initializeApp();

// Take the log passed to this HTTP endpoint and insert it into
// Firestore under the path /main_iot/:documentId/logs and /main_iot/:documentId/last_soil_read
exports.addLog = functions.https.onRequest(async (req, res) => {
    // Grab the text parameter.
    //const original = req.query.text;
    
    // Push the new message into Firestore using the Firebase Admin SDK.
    //const writeResult = await admin.firestore().collection('main_iot').add({original: original});
    
    // Send back a message that we've successfully written the message
    //res.json({result: `Message with ID: ${writeResult.id} added.`});



    //TODO: req.body -> 
    // {
    //  main_iot_serial: "7bd4",
    //  log: [
    //      {
    //          "aux_iot_serial": "87dsu",
    //          "read_value": "0.02"
    //      }
    //  ]
    // }
    console.log('body: ', req.body);
    const main_iot_serial = req.body.main_iot_serial;
    const newLogs = req.body.log;
    console.log('mainIotSerial: ', main_iot_serial);
    console.log('newLogs: ', newLogs);

    //TODO: achar doc pelo main_iot_serial informado
    const main_iotQ = (await admin.firestore().collection('main_iot').where('serial', '==', main_iot_serial).limit(1).get()).docs[0];
    const main_iot = main_iotQ.data();
    const mainIotId = main_iotQ.id;
    console.log('mainIot: ', main_iot);

    //TODO: montar lista de aux_iot com base nos seriais informados (buscar nome do aux_iot com base no serial)
    var lastSoilUpdate = {};
    var logTxt = '';
    newLogs.forEach(e => {
        console.log('for log: ', e);
        const serial = e.aux_iot_serial;
        console.log('for auxIotSerial: ', serial);
        const value = e.read_value;
        var aux_iot;
        for (var key in main_iot.aux_iot){
            var obj = main_iot.aux_iot[key];
            if (obj.serial == serial) {
                aux_iot = obj;
            }
        }
        console.log('for auxIot: ', aux_iot);
        lastSoilUpdate[serial] = {
            value: value,
            status: getReadStatus(value)
        };
        logTxt += `${aux_iot.name} - ${value}\n`;
    });
    console.log('lastSoilUpdate: ', lastSoilUpdate);
    console.log('logTxt: ', logTxt);
    //console.log('timestamp: ', admin.firestore.FieldValue.serverTimestamp());
    console.log('timestamp: ', admin.firestore.Timestamp.now());


    //TODO: adicionar entrada em logs -> 
    // {
    //  msg: Umidade Jardim Frontal - 0,020\nUmidade Jardim Exterior - 0,020\nUmidade Jardim Interno - 0,020,
    //  timestamp: timestamp.now()
    // }

    const logResult = await admin.firestore().collection('main_iot').doc(mainIotId).update({
        logs: admin.firestore.FieldValue.arrayUnion(
            {
                msg: logTxt,
                timestamp: admin.firestore.Timestamp.now()
            }
        ),
        last_soil_read: lastSoilUpdate
    });
    console.log('logResult: ', logResult);
    res.status(200).send('log added');

    //TODO: modificar last_soil_read ->
    // {
    //  "aux_iot_name": {
    //      "status": (low/medium/high de acordo com value),
    //      "value": (value recebido),
    //  }
    // }

    //const soilResult = main_iot_serial.update({last_soil_read: lastSoilUpdate});
    //console.log('soilResult: ', soilResult);
  });


// Listen for changes mades to /users/:documentId/settings and pushes the changes to the iot
exports.settingsChange = functions.firestore.document('/users/{documentId}')
.onUpdate((snap, context) => {
  // Grab the current value of what was written to Firestore.
  //const original = snap.data().original;

  // Access the parameter `{documentId}` with `context.params`
  //functions.logger.log('Uppercasing', context.params.documentId, original);

  //const uppercase = original.toUpperCase();

  // You must return a Promise when performing asynchronous tasks inside a Functions such as
  // writing to Firestore.
  // Setting an 'uppercase' field in Firestore document returns a Promise.
  //return snap.ref.set({uppercase}, {merge: true});


  //TODO: pegar novo valor do faucet e enviar para o iot
});


function getReadStatus(value) {
    if (value < 0.01) {
        return 'low';
    }

    if (value < 0.035) {
        return 'medium';
    }

    return 'high';
}