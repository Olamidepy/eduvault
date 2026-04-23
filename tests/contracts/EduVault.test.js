const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("EduVault", function () {
  async function deployVault() {
    const [creator, buyer] = await ethers.getSigners();
    const EduVault = await ethers.getContractFactory("EduVault");
    const vault = await EduVault.deploy();
    await vault.waitForDeployment();

    return { buyer, creator, vault };
  }

  function tokenIds(values) {
    return values.map((value) => Number(value));
  }

  it("mints a token and stores its tokenURI", async function () {
    const { creator, vault } = await deployVault();
    const uri = "ipfs://eduvault/material-1";

    await vault.connect(creator).mint(uri);

    assert.equal(await vault.ownerOf(0), creator.address);
    assert.equal(await vault.tokenURI(0), uri);
    assert.deepEqual(tokenIds(await vault.tokensOfOwner(creator.address)), [0]);
  });

  it("updates owner token enumeration after transfers", async function () {
    const { buyer, creator, vault } = await deployVault();

    await vault.connect(creator).mint("ipfs://eduvault/material-1");
    await vault.connect(creator).transferFrom(creator.address, buyer.address, 0);

    assert.deepEqual(tokenIds(await vault.tokensOfOwner(creator.address)), []);
    assert.deepEqual(tokenIds(await vault.tokensOfOwner(buyer.address)), [0]);
    assert.equal(await vault.ownerOf(0), buyer.address);
  });
});
