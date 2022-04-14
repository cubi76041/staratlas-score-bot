import {
  createRearmInstruction,
  createRefeedInstruction,
  createRefuelInstruction,
  createRepairInstruction,
  getAllFleetsForUserPublicKey,
  getScoreVarsInfo,
  getScoreVarsShipInfo,
} from "@staratlas/factory";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { base58_to_binary } from "base58-js";
import {
  FLEET_PROGRAM_ID,
  WALLET_SECRET_KEY,
  SERUM_API_URL,
  RESOURCE_TIMEOUT_IN_SECONDS,
  RESOURCE_TOKEN_ACCOUNT,
  TIME_TO_SCAN_FLEET_IN_SECONDS,
} from "./config.mjs";

const ownerAccount = Keypair.fromSecretKey(base58_to_binary(WALLET_SECRET_KEY));

const conn = new Connection(SERUM_API_URL);
const fleetProgram = new PublicKey(FLEET_PROGRAM_ID);

const writeLog = (...msg) => {
  console.log("[%s] %s", new Date(), ...msg);
};

const sendTransaction = (transaction) => {
  conn.sendTransaction(transaction, [ownerAccount], {
    skipPreflight: true,
    preflightCommitment: "processed",
  });
};

const getResourcesTimeout = (fleet) => {
  const currentTime = Date.now() / 1000;

  const timeToOutOfFuel =
    fleet.fueledAtTimestamp.toNumber() +
    fleet.fuelCurrentCapacity.toNumber() -
    currentTime;
  const timeToOutOfFood =
    fleet.fedAtTimestamp.toNumber() +
    fleet.foodCurrentCapacity.toNumber() -
    currentTime;
  const timeToOutOfArms =
    fleet.armedAtTimestamp.toNumber() +
    fleet.armsCurrentCapacity.toNumber() -
    currentTime;
  const timeToOutOfToolkit =
    fleet.repairedAtTimestamp.toNumber() +
    fleet.healthCurrentCapacity.toNumber() -
    currentTime;

  return {
    timeToOutOfFood,
    timeToOutOfFuel,
    timeToOutOfArms,
    timeToOutOfToolkit,
  };
};

const reSupplyFleet = async (scoreVarsInfo, fleet) => {
  const resourceTimeout = getResourcesTimeout(fleet);

  if (
    Math.min(
      resourceTimeout.timeToOutOfFuel,
      resourceTimeout.timeToOutOfFood,
      resourceTimeout.timeToOutOfArms,
      resourceTimeout.timeToOutOfToolkit
    ) > RESOURCE_TIMEOUT_IN_SECONDS
  ) {
    return [];
  }

  const instructions = [];
  const shipVarsInfo = await getScoreVarsShipInfo(
    conn,
    fleetProgram,
    fleet.shipMint
  );
  const shipPubKey = fleet.shipMint.toString();

  const burnedFood = Math.round(
    (shipVarsInfo.foodMaxReserve -
      (resourceTimeout.timeToOutOfFood * 1000) /
        shipVarsInfo.millisecondsToBurnOneFood) *
      fleet.shipQuantityInEscrow
  );
  const burnedFuel = Math.round(
    (shipVarsInfo.fuelMaxReserve -
      (resourceTimeout.timeToOutOfFuel * 1000) /
        shipVarsInfo.millisecondsToBurnOneFuel) *
      fleet.shipQuantityInEscrow
  );
  const burnedArms = Math.round(
    (shipVarsInfo.armsMaxReserve -
      (resourceTimeout.timeToOutOfArms * 1000) /
        shipVarsInfo.millisecondsToBurnOneArms) *
      fleet.shipQuantityInEscrow
  );
  const burnedToolkit = Math.round(
    (shipVarsInfo.toolkitMaxReserve -
      (resourceTimeout.timeToOutOfToolkit * 1000) /
        shipVarsInfo.millisecondsToBurnOneToolkit) *
      fleet.shipQuantityInEscrow
  );

  if (burnedFood > 0) {
    const refeedTransaction = await createRefeedInstruction(
      conn,
      ownerAccount.publicKey,
      ownerAccount.publicKey,
      burnedFood,
      fleet.shipMint,
      scoreVarsInfo.foodMint,
      RESOURCE_TOKEN_ACCOUNT.FOOD,
      fleetProgram
    );

    instructions.push(refeedTransaction);
    writeLog("Refeed ship", shipPubKey, ", qty:", burnedFood);
  }

  if (burnedFuel > 0) {
    const refuelTransaction = await createRefuelInstruction(
      conn,
      ownerAccount.publicKey,
      ownerAccount.publicKey,
      burnedFuel,
      fleet.shipMint,
      scoreVarsInfo.fuelMint,
      RESOURCE_TOKEN_ACCOUNT.FUEL,
      fleetProgram
    );

    instructions.push(refuelTransaction);
    writeLog("Refuel ship", shipPubKey, ", qty:", burnedFuel);
  }

  if (burnedArms > 0) {
    const rearmsTransaction = await createRearmInstruction(
      conn,
      ownerAccount.publicKey,
      ownerAccount.publicKey,
      burnedArms,
      fleet.shipMint,
      scoreVarsInfo.armsMint,
      RESOURCE_TOKEN_ACCOUNT.ARMS,
      fleetProgram
    );

    instructions.push(rearmsTransaction);
    writeLog("Rearms ship", shipPubKey, ", qty:", burnedArms);
  }

  if (burnedToolkit > 0) {
    const repairTransaction = await createRepairInstruction(
      conn,
      ownerAccount.publicKey,
      ownerAccount.publicKey,
      burnedToolkit,
      fleet.shipMint,
      scoreVarsInfo.toolkitMint,
      RESOURCE_TOKEN_ACCOUNT.TOOLKIT,
      fleetProgram
    );

    instructions.push(repairTransaction);
    writeLog("Repair ship", shipPubKey, ", qty:", burnedToolkit);
  }

  return instructions;
};

const scanFleets = async () => {
  writeLog("Start to scan fleets ...");
  const scoreVarsInfo = await getScoreVarsInfo(conn, fleetProgram);

  const fleets =
    (await getAllFleetsForUserPublicKey(
      conn,
      ownerAccount.publicKey,
      fleetProgram
    )) || [];

  for (let fleet of fleets) {
    const transaction = new Transaction();
    const fleetInstructions = await reSupplyFleet(scoreVarsInfo, fleet);

    if (fleetInstructions.length > 0) {
      fleetInstructions.forEach((tx) => transaction.add(tx));

      writeLog("Re-supply fleet", fleet.shipMint.toString(), "...");
      sendTransaction(transaction);
      writeLog("Done !");
      console.log("-----------------------------------------");
    }
  }
};

setInterval(scanFleets, TIME_TO_SCAN_FLEET_IN_SECONDS * 1000);
