// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

contract EduVault is ERC721URIStorage {
    uint256 private _nextTokenId;

    // Mapping from owner to list of owned token IDs
    mapping(address => uint256[]) private _ownedTokens;

    constructor() ERC721("EduVault", "EDV") {}

    // Allow anyone to mint their own NFT
    function mint(string memory uri) external {
        uint256 tokenId = _nextTokenId;
        _nextTokenId += 1;

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, uri);
    }

    // Get all token IDs owned by a specific address
    function tokensOfOwner(address owner) external view returns (uint256[] memory) {
        return _ownedTokens[owner];
    }

    // Override to clean up ownership tracking when transferring
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = super._update(to, tokenId, auth);

        if (from != address(0)) {
            // remove token from old owner list
            uint256[] storage fromTokens = _ownedTokens[from];
            for (uint256 i = 0; i < fromTokens.length; i++) {
                if (fromTokens[i] == tokenId) {
                    fromTokens[i] = fromTokens[fromTokens.length - 1];
                    fromTokens.pop();
                    break;
                }
            }
        }

        if (to != address(0)) {
            _ownedTokens[to].push(tokenId);
        }

        return from;
    }
}
