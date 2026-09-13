import { memoryStorage } from "../../src/adapters/memory";
import { runStorageContract } from "../../src/testing";

runStorageContract("memory", async () => memoryStorage());
