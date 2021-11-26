const functions = require("firebase-functions");
const admin = require("firebase-admin");
const net = require("net");
const axios = require("axios");
admin.initializeApp();

// Take the log passed to this HTTP endpoint and insert it into
// Firestore under the path /main_iot/:documentId/logs
// and /main_iot/:documentId/last_soil_read
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
  const mainIotSerial = req.body.main_iot_serial;
  const newLogs = req.body.log;

  // Gets the main_iot with given serial
  const mainIotQ = (await admin.firestore().collection("main_iot")
      .where("serial", "==", mainIotSerial).limit(1).get()).docs[0];
  const mainIot = mainIotQ.data();
  const mainIotId = mainIotQ.id;

  // creates the new log info and soil read
  const lastSoilUpdate = {};
  let logTxt = "";
  newLogs.forEach((e) => {
    const serial = e.aux_iot_serial;
    const value = e.read_value;
    let auxIot;
    // eslint-disable-next-line
    for (const key in mainIot.aux_iot) {
      const obj = mainIot.aux_iot[key];
      if (obj.serial == serial) {
        auxIot = obj;
      }
    }
    lastSoilUpdate[auxIot.name] = {
      value: value,
      status: getReadStatus(value),
    };
    logTxt += `${auxIot.name} - ${value}\n`;
  });

  // Writes the new info to firestore
  await admin.firestore()
      .collection("main_iot").doc(mainIotId).update({
        logs: admin.firestore.FieldValue.arrayUnion(
            {
              msg: logTxt,
              timestamp: admin.firestore.Timestamp.now(),
            },
        ),
        last_soil_read: lastSoilUpdate,
      });
  res.status(200).send("log added");
});

exports.updateIotLink = functions.https.onRequest(async (req, res) => {
  // req.body ->
  // {
  //  main_iot_serial: "7bd4",
  //  link: "http://127.0.0.1:8080"
  // }


  // Gets request information
  const mainIotSerial = req.body.main_iot_serial;
  const iotLink = req.body.link;

  // Gets the main iot with given serial
  const mainIotQ = (await admin.firestore().collection("main_iot")
      .where("serial", "==", mainIotSerial).limit(1).get()).docs[0];
  const mainIotId = mainIotQ.id;

  // Writes the new info to firestore
  await admin.firestore().collection("main_iot").doc(mainIotId).update({
    iot_link: iotLink,
  });
  res.status(200).send("log added");
});

exports.forecast = functions.https.onRequest(async (req, res) => {
  // req.body ->
  // {
  //  "lat": -12.8997,
  //  "lng": -38.3357,
  // }

  const response = await getRainCondition(req.body.lat, req.body.lng);
  if (response == null) {
    res.status(500).send("Error getting forecast");
  }

  res.status(200).send(response);
});


// Listen for changes mades to /users/:documentId
// and pushes the changes to the iot
exports.onUserChange = functions.firestore.document("users/{documentId}")
    .onUpdate((change, context) => {
      const newStatus = change.after.data();
      const oldStatus = change.before.data();
      const userId = context.params.documentId;

      // If the change is on faucet status,
      // pushes the new value to the user main iot
      if (newStatus.settings.faucet_on != oldStatus.settings.faucet_on) {
        const newFaucetStatus = newStatus.settings.faucet_on;
        changeIotFaucetStatusForUser(userId, newFaucetStatus);
        return null;
      }

      return null;
    });

exports.onMainIotChange = functions.firestore.document("main_iot/{documentId}")
    .onUpdate((change, context) => {
      const newStatus = change.after.data();
      const oldStatus = change.before.data();
      const userId = newStatus.user_id;
      const link = newStatus.iot_link;

      // We only want to get changes made to last soil read
      if (newStatus.last_soil_read == oldStatus.last_soil_read) {
        return null;
      }

      // checks if any value is 'low', if so activates the users faucet
      // else turns off the faucet
      const newSoilRead = newStatus.last_soil_read;

      // Checks if any status is low
      let isAnyStatusLow = false;
      // eslint-disable-next-line
      for (const key in newSoilRead) {
        const obj = newSoilRead[key];
        if (obj.status == "low") {
          isAnyStatusLow = true;
          break;
        }
      }
      if (!isAnyStatusLow) {
        return null;
      }

      // checks if user has the config to turn on faucet on a low value
      admin.firestore().collection("users").doc(userId).get().then((u) => {
        // End if no user was found
        if (u == null || u.data() == null) {
          return;
        }

        const user = u.data();
        if (!user.settings.config["1"]) {
          return null;
        }

        // Checks if user has the config to not turn on faucet on rainy days
        if (user.settings.config["3"]) {
          // Checks if it will rain on the current day
          willRainIn(user.lat, user.lng).then((willRain) => {
            if (willRain) {
              return null;
            }
          });
        }

        changeIotFaucetStatusForLink(link, true);
        return null;
      });

      return null;
    });

/**
 * Changes the faucet status for the user
 * @param {*} userId
 * @param {*} value
 */
async function changeIotFaucetStatusForUser(userId, value) {
  const mainIotQ = (await admin.firestore().collection("main_iot")
      .where("user_id", "==", userId).limit(1).get()).docs[0];
  const mainIot = mainIotQ.data();
  const link = mainIot.iot_link;
  changeIotFaucetStatusForLink(link, value);
}

/**
 * Changes the faucet status for given tcp link
 * @param {*} link
 * @param {*} value
 */
function changeIotFaucetStatusForLink(link, value) {
  const ip = link.split(":")[0];
  const port = link.split(":")[1];

  const client = new net.Socket();
  console.log("connecting to ", link);
  client.connect(port, ip, async function() {
    console.log("connected to ", link);
    let msg = "FAUCET_STATUS OFF";
    if (value) {
      msg = "FAUCET_STATUS ON";
    }
    await sleep(1000);
    console.log("sending ", msg, " to client");
    client.write(msg);
    client.end();
  });

  client.on("data", function(data) {
    console.log("Received: " + data);
    // client.destroy(); // kill client after server's response
  });

  client.on("close", function() {
    console.log("Connection closed");
  });

  client.on("error", function(err) {
    console.log(err);
    client.end();
  });

  client.on("end", () => {
    console.log("Connection ended");
  });
}

/**
 *
 * Gets rain condition for given position
 *
 * @param {double} lat
 * @param {double} lng
 * @return {*}
 */
async function getRainCondition(lat, lng) {
  const config = {
    baseURL: "https://api.openweathermap.org/data/2.5",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    params: {
      lat: lat,
      lon: lng,
      lang: "pt_br",
      exclude: "minutely,hourly",
      units: "metric",
      appid: "b9997332ba677618289bc7297e3e719d",
    },
  };

  const r = await axios.get("onecall", config);
  const response = r.data;

  const currentDayForecast = response.daily[0];
  const tomorrowForecast = response.daily[1];

  const prediction = {
    "today": {
      "min": currentDayForecast.temp.min,
      "max": currentDayForecast.temp.max,
      "current": response.current.temp,
      "status": response.current.weather[0].description,
      "uv": uviLevel(response.current.uvi),
      "humidity": response.current.humidity,
      "rain_chance": currentDayForecast.rain,
    },
    "tomorrow": {
      "min": tomorrowForecast.temp.min,
      "max": tomorrowForecast.temp.max,
      "current": null,
      "status": null,
      "uv": null,
      "humidity": null,
      "rain_chance": tomorrowForecast.rain,
    },
  };

  return prediction;
}

/**
 * Gets if will rain in the current day for given position
 * @param {*} lat
 * @param {*} lng
 * @return {*}
 */
async function willRainIn(lat, lng) {
  const forecast = await getRainCondition(lat, lng);

  const rainPrec = forecast.today.rain_chance;

  if (rainPrec == null) {
    return false;
  }

  const rainPerHour = rainPrec / 24;

  return rainPerHour > 0.1;
}

/**
 * Get status for last soil read
 * @param {*} value
 * @return {*}
 */
function getReadStatus(value) {
  if (value < 0.01) {
    return "low";
  }

  if (value < 0.035) {
    return "medium";
  }

  return "high";
}

/**
 * Gets uvi level for value
 * @param {*} value
 * @return {*}
 */
function uviLevel(value) {
  if (value < 2) {
    return "Baixo";
  }

  if (value < 5) {
    return "Moderado";
  }

  if (value < 7) {
    return "Alto";
  }

  if (value < 10) {
    return "Muito Alto";
  }

  return "Extremo";
}

/**
 * Stops the thread for given time
 * @param {*} ms
 * @return {*}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
