const functions = require("firebase-functions");
const admin = require('firebase-admin');
const net = require('net');
admin.initializeApp();

// Take the log passed to this HTTP endpoint and insert it into
// Firestore under the path /main_iot/:documentId/logs and /main_iot/:documentId/last_soil_read
exports.addLog = functions.https.onRequest(async (req, res) => {
    // req.body -> 
    // {
    //  main_iot_serial: "7bd4",
    //  log: [
    //      {
    //          "aux_iot_serial": "87dsu",
    //          "read_value": "0.02"
    //      }
    //  ]
    // }

    // Gets the information from request
    const main_iot_serial = req.body.main_iot_serial;
    const newLogs = req.body.log;

    // Gets the main_iot with given serial
    const main_iotQ = (await admin.firestore().collection('main_iot').where('serial', '==', main_iot_serial).limit(1).get()).docs[0];
    const main_iot = main_iotQ.data();
    const mainIotId = main_iotQ.id;

    // creates the new log info and soil read
    var lastSoilUpdate = {};
    var logTxt = '';
    newLogs.forEach(e => {
        const serial = e.aux_iot_serial;
        const value = e.read_value;
        var aux_iot;
        for (var key in main_iot.aux_iot) {
            var obj = main_iot.aux_iot[key];
            if (obj.serial == serial) {
                aux_iot = obj;
            }
        }
        lastSoilUpdate[serial] = {
            value: value,
            status: getReadStatus(value)
        };
        logTxt += `${aux_iot.name} - ${value}\n`;
    });

    // Writes the new info to firestore
    const logResult = await admin.firestore().collection('main_iot').doc(mainIotId).update({
        logs: admin.firestore.FieldValue.arrayUnion(
            {
                msg: logTxt,
                timestamp: admin.firestore.Timestamp.now()
            }
        ),
        last_soil_read: lastSoilUpdate
    });
    res.status(200).send('log added');
});

exports.updateIotLink = functions.https.onRequest(async (req, res) => {
    // req.body -> 
    // {
    //  main_iot_serial: "7bd4",
    //  link: "http://127.0.0.1:8080"
    // }


    // Gets request information
    const main_iot_serial = req.body.main_iot_serial;
    const iotLink = req.body.link;

    // Gets the main iot with given serial
    const main_iotQ = (await admin.firestore().collection('main_iot').where('serial', '==', main_iot_serial).limit(1).get()).docs[0];
    const main_iot = main_iotQ.data();
    const mainIotId = main_iotQ.id;

    // Writes the new info to firestore
    const result = await admin.firestore().collection('main_iot').doc(mainIotId).update({
        iot_link: iotLink
    });
    res.status(200).send('log added');
});


// Listen for changes mades to /users/:documentId and pushes the changes to the iot
exports.onUserChange = functions.firestore.document('users/{documentId}')
    .onUpdate((change, context) => {
        const newStatus = change.after.data();
        const oldStatus = change.before.data();
        const userId = context.params.documentId;

        // If the change is on faucet status, pushes the new value to the user main iot
        if (newStatus.settings.faucet_on != oldStatus.settings.faucet_on) {
            const newFaucetStatus = newStatus.settings.faucet_on;
            changeIotFaucetStatusForUser(userId, newFaucetStatus);
            return null;
        }

        // If the change is on a config 
        if (newStatus.settings.config != oldStatus.settings.config) {
            const newConfig = newStatus.settings.config;
            //TODO: realizar query on config
            //TODO: pegar id da config modificada
            //TODO: identificar config modificada
            //TODO: enviar modificação para iot
            return null;
        }

        return null;
    });

exports.onMainIotChange = functions.firestore.document('main_iot/{documentId}')
    .onUpdate((change, context) => {
        const newStatus = change.after.data();
        const oldStatus = change.before.data();
        const serial = newStatus.serial;
        const userId = newStatus.user_id;
        const link = newStatus.iot_link;

        // We only want to get changes made to last soil read
        if (newStatus.last_soil_read == oldStatus.last_soil_read) {
            return null;
        }

        // checks if any value is 'low', if so activates the users faucet
        // else turns off the faucet
        const newSoilRead = newStatus.last_soil_read;

        //Checks if any status is low
        var isAnyStatusLow = false;
        for (var key in newSoilRead) {
            var obj = newSoilRead[key];
            if (obj.status == 'low') {
                isAnyStatusLow = true;
                break;
            }
        }
        if (!isAnyStatusLow) {
            return null;
        }

        //checks if user has the config to turn on faucet on a low value
        admin.firestore().collection('users').doc(userId).get().then(u => {
            // End if no user was found
            if (u == null || u.data() == null) {
                return;
            }

            const user = u.data();
            if (!user.settings.config['1']) {
                return null;
            }

            // Checks if user has the config to not turn on faucet on rainy days
            if (user.settings.config['3']) {
                // Checks if it will rain on the current day
                const willRain = getRainCondition(user.lat, user.lng);
                if (willRain) {
                    return null;
                }
            }

            changeIotFaucetStatusForLink(link, true);
            return null;
        });

        return null;
    });

async function changeIotFaucetStatusForUser(userId, value) {
    const main_iotQ = (await admin.firestore().collection('main_iot').where('user_id', '==', userId).limit(1).get()).docs[0];
    const main_iot = main_iotQ.data();
    const link = main_iot.iot_link;
    changeIotFaucetStatusForLink(link, value);
}

function changeIotFaucetStatusForLink(link, value) {
    const ip = link.split(":")[0];
    const port = link.split(":")[1];

    var client = new net.Socket();
    client.connect(port, ip, async function () {
        var msg = 'FAUCET_STATUS OFF';
        if (value) {
            msg = 'FAUCET_STATUS ON';
        }
        await sleep(1000);
        client.write(msg);
        client.end();
    });

    client.on('data', function (data) {
        console.log('Received: ' + data);
        //client.destroy(); // kill client after server's response
    });

    client.on('close', function () {
        console.log('Connection closed');
    });

    client.on('error', function(err) {
        console.log(err)
     })
}

function getRainCondition(lat, lnt) {
    //TODO: Get rain condition for current day, given lat lng
    return true;
}

function getReadStatus(value) {
    if (value < 0.01) {
        return 'low';
    }

    if (value < 0.035) {
        return 'medium';
    }

    return 'high';
}

function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }