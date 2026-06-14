const express = require('express');
const axios = require('axios');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const CONSTANTS = {
    SUB_KEY: 'd701a2043aa24d7ebb37e9adf60d043b',
    PRODUCT: 'SalaDoFuturo',
    BASE_SED: 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi',
    BASE_IPTV: 'https://edusp-api.ip.tv'
};

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    console.log(`\n=== [BFF MATRIZ DEFINITIVA] SINCRONIZANDO CONTA: ${user} ===`);

    try {
        // ----------------------------------------------------------
        // 1. LOGIN SED
        // ----------------------------------------------------------
        const loginRes = await axios.post(`${CONSTANTS.BASE_SED}/credenciais/api/LoginCompletoToken`,
            { user, senha },
            { headers: {
                'Content-Type': 'application/json',
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'User-Agent': 'Mozilla/5.0'
            }}
        );

        const tokenSed = loginRes.data.token;
        const dadosUsuario = loginRes.data.DadosUsuario || {};
        const cdUsuario9 = dadosUsuario.CD_USUARIO?.toString();
        const cdUsuario8 = cdUsuario9 ? cdUsuario9.substring(0, 8) : '';
        const nomeCompletoAluno = dadosUsuario.NAME || 'Estudante';
        const raCompletoFormatado = `${cdUsuario8}${user.slice(-3)}`.toUpperCase();

        const cookiesRecebidos = loginRes.headers['set-cookie'] || [];
        const cookiesFiltrados = cookiesRecebidos.map(cookie => cookie.split(';')[0]).join('; ');

        const sedConfig = {
            headers: {
                'Authorization': `Bearer ${tokenSed}`,
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'Cookie': cookiesFiltrados,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            }
        };

        // ----------------------------------------------------------
        // 2. BUSCAR TURMA E COLETAR ID DA ESCOLA [LOG #4]
        // ----------------------------------------------------------
        let infoTurma = {};
        let schoolId = null;
        try {
            const turmaRes = await axios.get(
                `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`, 
                sedConfig
            );
            if (Array.isArray(turmaRes.data) && turmaRes.data.length > 0) infoTurma = turmaRes.data[0];
            else if (turmaRes.data?.data) infoTurma = Array.isArray(turmaRes.data.data) ? turmaRes.data.data[0] : turmaRes.data.data;
            schoolId = infoTurma?.CodigoEscola || infoTurma?.CD_ESCOLA;
        } catch (err) { console.error(`[BFF] Erro Turma: ${err.message}`); }

        // ----------------------------------------------------------
        // 3. ANCORAGEM DE TEMPO DO BIMESTRE CORRENTE [LOG #4]
        // ----------------------------------------------------------
        let dataInicioBimestre = new Date("2026-04-22T00:00:00.000Z"); 
        if (schoolId) {
            try {
                const bimestreRes = await axios.get(`${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Bimestre/ListarBimestres?escolaId=${schoolId}`, sedConfig);
                const listaBimestres = bimestreRes.data?.data || bimestreRes.data || [];
                if (Array.isArray(listaBimestres)) {
                    const bAtivo = listaBimestres.find(b => b.Ativo === true || b.NumeroBimestre === 2);
                    if (bAtivo?.DataInicio) {
                        dataInicioBimestre = new Date(bAtivo.DataInicio);
                    }
                }
            } catch (errBim) { console.error(`[BFF] Erro Calendário: ${errBim.message}`); }
        }

        // ----------------------------------------------------------
        // 4. HANDSHAKE PROTOCOLO IP.TV
        // ----------------------------------------------------------
        let authTokenIptv = null;
        try {
            const iptvHandshake = await axios.post(`${CONSTANTS.BASE_IPTV}/registration/edusp/token`,
                { token: tokenSed },
                {
                    httpsAgent,
                    headers: {
                        'x-api-realm': 'edusp',
                        'x-api-platform': 'webclient',
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0'
                    }
                }
            );
            authTokenIptv = iptvHandshake.data?.auth_token;
        } catch (err) { console.error(`[BFF] Erro Handshake: ${err.message}`); }

        // ----------------------------------------------------------
        // 5. PROCESSAMENTO DOS NOVOS CONTADORES EXATOS (IP.TV)
        // ----------------------------------------------------------
        let countPendentes = 0;
        let countExpiradas = 0;
        let countAvaliacoes = 0; 
        let countRedacoes = 0;

        if (authTokenIptv) {
            try {
                const configIptvBase = {
                    httpsAgent,
                    headers: { 
                        'x-api-key': authTokenIptv, 
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0'
                    }
                };

                const roomsRes = await axios.get(`${CONSTANTS.BASE_IPTV}/room/user?list_all=true&with_cards=true`, configIptvBase);
                const rooms = roomsRes.data?.rooms || [];
                
                const targets = [];
                rooms.forEach(r => {
                    if (r.name) targets.push(`publication_target=${r.name}`);
                    if (Array.isArray(r.category_ids)) {
                        r.category_ids.forEach(id => targets.push(`publication_target=${id}`));
                    }
                });

                if (targets.length === 0) targets.push('publication_target=all');
                const targetQuery = targets.join('&');

                // A. CORREÇÃO DAS PESQUISAS [LOG #23]
                try {
                    const surveyRes = await axios.get(`${CONSTANTS.BASE_IPTV}/survey/todo/count?${targetQuery}&filter_expired=true&with_answer=true&answer_statuses=draft`, configIptvBase);
                    countAvaliacoes = surveyRes.data?.count || surveyRes.data?.required_count || 0;
                } catch (eSurv) { console.error(`[BFF] Erro /survey/todo/count: ${eSurv.message}`); }

                // B. TAREFAS PENDENTES [LOG #35]
                try {
                    const urlPendentes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&expired_only=false&filter_expired=true&is_exam=false&is_essay=false&with_answer=true&answer_statuses=draft&answer_statuses=pending`;
                    const pendentesRes = await axios.get(urlPendentes, configIptvBase);
                    const rawPendentes = Array.isArray(pendentesRes.data) ? pendentesRes.data : (pendentesRes.data?.data || []);
                    
                    countPendentes = rawPendentes.filter(t => 
                        (t.answer_id === null || !t.answer_id) && 
                        new Date(t.publish_at || t.start_date) >= dataInicioBimestre
                    ).length;
                } catch (ePend) { console.error(`[BFF] Erro Pendentes: ${ePend.message}`); }

                // C. TAREFAS EXPIRADAS [LOG #37]
                try {
                    const urlExpiradas = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&expired_only=true&filter_expired=false&with_answer=true&answer_statuses=draft&answer_statuses=pending`;
                    const expiradasRes = await axios.get(urlExpiradas, configIptvBase);
                    const rawExpiradas = Array.isArray(expiradasRes.data) ? expiradasRes.data : (expiradasRes.data?.data || []);
                    
                    const dataLimiteCorte = Date.now() - (50 * 24 * 60 * 60 * 1000);
                    countExpiradas = rawExpiradas.filter(t => new Date(t.expire_at || t.end_date).getTime() > dataLimiteCorte).length;
                } catch (eExp) { console.error(`[BFF] Erro Expiradas: ${eExp.message}`); }

                // D. REDAÇÕES ISOLADAS [LOG #40]
                try {
                    const urlRedacoes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&is_essay=true&filter_expired=true&with_answer=true`;
                    const redacoesRes = await axios.get(urlRedacoes, configIptvBase);
                    const rawRedacoes = Array.isArray(redacoesRes.data) ? redacoesRes.data : (redacoesRes.data?.data || []);
                    countRedacoes = rawRedacoes.filter(t => new Date(t.publish_at || t.start_date) >= dataInicioBimestre).length;
                } catch (eRed) { console.error(`[BFF] Erro Redações: ${eRed.message}`); }

            } catch (errRooms) { console.error(`[BFF] Erro Estrutura Canais IPTV: ${errRooms.message}`); }
        }

        // Retorno Limpo
        res.json({
            aluno: {
                nome: nomeCompletoAluno,
                codigo: raCompletoFormatado, 
                escola: infoTurma.NomeEscola || 'Não Informada',
                turma: infoTurma.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: countPendentes,
                expiradas: countExpiradas,
                avaliacoes: countAvaliacoes, 
                redacoes: countRedacoes
            }
        });

    } catch (error) {
        console.error(`[BFF] Erro Operacional: ${error.message}`);
        res.status(500).json({ error: "Falha de execução na consolidação da árvore de dados." });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF Produção Homologado ativo na porta ${PORT}`));
