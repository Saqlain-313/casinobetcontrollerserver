import dotenv from 'dotenv';
import axios from "axios";

import adminModel from '../models/adminModel.js';
import { fetchMatchData, fetchMatchList } from '../services/matchApi/index.js';

dotenv.config();

export const getCricketData = async (req, res) => {
  console.log("getCricketData called");
  try {
    const data = await fetchMatchList(4);

    console.log("datadatadatadata", data)

    if (data.success) {
      const t1 = data.data.t1 || [];
      const t2 = data.data.t2 || [];
      const allMatches = [...t1, ...t2];

      const transformed = allMatches
        .map((match) => {
          const team1Odds =
            match.section && match.section.length >= 1
              ? {
                home: match.section[0].odds[0]?.odds?.toString() || '0',
                away: match.section[0].odds[1]?.odds?.toString() || '0',
              }
              : { home: '0', away: '0' };

          const team2Odds =
            match.section && match.section.length >= 2
              ? {
                home: match.section[1].odds[0]?.odds?.toString() || '0',
                away: match.section[1].odds[1]?.odds?.toString() || '0',
              }
              : { home: '0', away: '0' };

          const oddsArr = [team1Odds, { home: '0', away: '0' }, team2Odds];

          return {
            id: match.beventId || match.oldgmid || match.gmid,
            title: match.cname,
            beventId: match.beventId || null,
            match: match.ename,
            date: match.stime,
            channels: [],
            odds: oddsArr,
            inplay: match.iplay,
            tv: match.tv,
            bm: match.bm,
            f: match.f,
          };
        })
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      const now = new Date();
      const filteredMatches = transformed.filter((match) => {
        const matchDate = new Date(match.date);
        return match.inplay === true || matchDate >= now;
      });

      return res.status(200).json({ success: true, matches: filteredMatches });
    } else {
      return res
        .status(400)
        .json({ success: false, message: 'Failed to fetch matches' });
    }
  } catch (err) {
    console.error('Error fetching matches:', err.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const fetchCrirketBettingData = async (req, res) => {
  const { gameid } = req.query;

  if (!gameid) {
    return res.status(400).json({ success: false, message: 'Missing gameid' });
  }

  try {
    const json = await fetchMatchData(gameid, 4);

    if (json.success) {
      return res.status(200).json({ success: true, data: json });
    } else {
      return res
        .status(500)
        .json({ success: false, message: 'Invalid response from API' });
    }
  } catch (error) {
    console.error('Error in fetchCrirketBettingData:', error.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};


export const getDiamondEvents = async (req, res) => {

  console.log("getDiamondEvents")
  try {
    const response = await axios.get(
      "https://scoreapi.nautical7.com/diamond/events/10",
      {
        headers: {
          "X-API-Key":
            "sck_Wr_0pAp2uAdClpn8uLulP-Iw849M_Lsq",
        },
      }
    );

    // console.log("response11111999", response.data)

    return res.status(200).json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    console.error(
      "Diamond Events API Error:",
      error.response?.data || error.message
    );

    return res.status(error.response?.status || 500).json({
      success: false,
      message: "Failed to fetch diamond events",
      error: error.response?.data || error.message,
    });
  }
};
export const getDiamondEventsData = async (req, res) => {

  console.log("getDiamondEvents")
  try {
    const response = await axios.get(
      "https://scoreapi.nautical7.com/diamond/odds/10_894750581",
      {
        headers: {
          "X-API-Key":
            "sck_Wr_0pAp2uAdClpn8uLulP-Iw849M_Lsq",
        },
      }
    );

    console.log("response data", response.data)

    return res.status(200).json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    console.error(
      "Diamond Events API Error:",
      error.response?.data || error.message
    );

    return res.status(error.response?.status || 500).json({
      success: false,
      message: "Failed to fetch diamond events",
      error: error.response?.data || error.message,
    });
  }
};